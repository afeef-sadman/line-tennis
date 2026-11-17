// WebSocket client for online matches: room create/join, reconnect with token,
// input streaming, snapshot receive. The server is authoritative.
export class NetClient {
  constructor(handlers) {
    this.h = handlers; // { onCreated, onJoined, onBegin, onState, onEvent, onPaused, onOpponent, onRematchVote, onRematchGo, onError, onLost }
    this.ws = null;
    this.code = null;
    this.side = -1;
    this.token = null;
    this.closedByUser = false;
    this.retry = 0;
    this.pingTimer = null;
    this.lastPong = 0;
    this.rtt = 0;
  }

  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.closedByUser = false;
      const ws = new WebSocket(this.url());
      this.ws = ws;
      const timeout = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout')); }, 6000);
      ws.onopen = () => {
        clearTimeout(timeout);
        this.retry = 0;
        this.startPing();
        resolve();
      };
      ws.onmessage = (e) => this.onMessage(e);
      ws.onerror = () => { clearTimeout(timeout); };
      ws.onclose = () => {
        clearTimeout(timeout);
        this.stopPing();
        if (this.closedByUser) return;
        if (this.code && this.token) this.tryReconnect();
        else { reject(new Error('closed')); this.h.onLost?.(); }
      };
    });
  }

  tryReconnect() {
    this.retry++;
    if (this.retry > 8) { this.h.onLost?.(); return; }
    setTimeout(async () => {
      if (this.closedByUser) return;
      try {
        await this.connect();
        this.send({ t: 'join', code: this.code, token: this.token });
      } catch { this.tryReconnect(); }
    }, Math.min(4000, 500 * this.retry));
  }

  startPing() {
    this.stopPing();
    this.lastPong = performance.now();
    this.pingTimer = setInterval(() => {
      this.send({ t: 'ping', ts: Date.now() });
      if (performance.now() - this.lastPong > 20000) {
        try { this.ws.close(); } catch {}
      }
    }, 5000);
  }
  stopPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  onMessage(e) {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    switch (m.t) {
      case 'created':
        this.code = m.code; this.side = m.side; this.token = m.token;
        this.h.onCreated?.(m);
        break;
      case 'joined':
        this.code = m.code; this.side = m.side; this.token = m.token;
        this.h.onJoined?.(m);
        break;
      case 'begin': this.h.onBegin?.(m); break;
      case 'state': this.h.onState?.(m); break;
      case 'ev': this.h.onEvent?.(m.e); break;
      case 'paused': this.h.onPaused?.(m.by); break;
      case 'opponent': this.h.onOpponent?.(m); break;
      case 'rematchVote': this.h.onRematchVote?.(m.votes); break;
      case 'rematchGo': this.h.onRematchGo?.(); break;
      case 'error': this.h.onError?.(m); break;
      case 'left': break;
      case 'pong':
        this.lastPong = performance.now();
        this.rtt = Date.now() - m.ts;
        break;
    }
  }

  create() { this.send({ t: 'create' }); }
  join(code) { this.send({ t: 'join', code }); }
  input(x, y, a) { this.send({ t: 'input', x, y, a }); }
  pause() { this.send({ t: 'pause' }); }
  rematch() { this.send({ t: 'rematch' }); }

  leave() {
    this.closedByUser = true;
    this.send({ t: 'leave' });
    this.stopPing();
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.code = null; this.side = -1; this.token = null; this.retry = 0;
  }
}