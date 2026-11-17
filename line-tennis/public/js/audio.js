// Tiny WebAudio synth: no audio files, all sounds generated procedurally.
let ctx = null;
let enabled = true;

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function setSoundEnabled(v) { enabled = v; }
export function soundEnabled() { return enabled; }
export function unlockAudio() { try { ac(); } catch { /* unsupported */ } }

function blip({ freq = 440, freqEnd = null, dur = 0.08, type = 'sine', gain = 0.16, delay = 0 }) {
  if (!enabled) return;
  try {
    const a = ac();
    const t0 = a.currentTime + delay;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freqEnd), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch { /* audio unavailable */ }
}

function noise({ dur = 0.06, gain = 0.1 }) {
  if (!enabled) return;
  try {
    const a = ac();
    const len = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = a.createBufferSource();
    src.buffer = buf;
    const g = a.createGain();
    g.gain.value = gain;
    const f = a.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 900;
    src.connect(f).connect(g).connect(a.destination);
    src.start();
  } catch { /* audio unavailable */ }
}

export const sfx = {
  hit(speed = 500) {
    const p = Math.min(1, speed / 1100);
    blip({ freq: 300 + p * 380, freqEnd: 180, dur: 0.09, type: 'triangle', gain: 0.2 });
    noise({ dur: 0.04, gain: 0.08 });
  },
  bounce() { blip({ freq: 190, freqEnd: 120, dur: 0.07, type: 'sine', gain: 0.12 }); },
  net() { blip({ freq: 140, freqEnd: 90, dur: 0.12, type: 'sawtooth', gain: 0.08 }); },
  wall() { blip({ freq: 240, freqEnd: 160, dur: 0.05, type: 'sine', gain: 0.07 }); },
  serve() { blip({ freq: 520, freqEnd: 700, dur: 0.1, type: 'triangle', gain: 0.14 }); },
  count() { blip({ freq: 660, dur: 0.07, type: 'sine', gain: 0.1 }); },
  go() { blip({ freq: 880, dur: 0.14, type: 'sine', gain: 0.14 }); },
  point(win) {
    if (win) {
      blip({ freq: 523, dur: 0.1, gain: 0.14 });
      blip({ freq: 659, dur: 0.1, gain: 0.14, delay: 0.1 });
      blip({ freq: 784, dur: 0.18, gain: 0.14, delay: 0.2 });
    } else {
      blip({ freq: 330, freqEnd: 220, dur: 0.22, type: 'triangle', gain: 0.13 });
    }
  },
  victory() {
    [523, 659, 784, 1047].forEach((f, i) => blip({ freq: f, dur: 0.22, gain: 0.15, delay: i * 0.14 }));
  },
  defeat() {
    [392, 330, 262].forEach((f, i) => blip({ freq: f, dur: 0.26, type: 'triangle', gain: 0.13, delay: i * 0.18 }));
  },
  click() { blip({ freq: 700, freqEnd: 500, dur: 0.04, type: 'sine', gain: 0.06 }); },
};