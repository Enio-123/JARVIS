// Sons da interface, sintetizados na hora (nada de arquivo de áudio, nada com direitos autorais).
// Todos são curtos e baixos, e tocam quando o microfone não está ouvindo.
export class Sfx {
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = true;
    this.out = ctx.createGain();
    this.out.gain.value = 0.32;
    // um pouco de "sala" para os sons não ficarem secos
    const delay = ctx.createDelay();
    delay.delayTime.value = 0.13;
    const fb = ctx.createGain();
    fb.gain.value = 0.22;
    const wet = ctx.createGain();
    wet.gain.value = 0.25;
    this.out.connect(ctx.destination);
    this.out.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(wet).connect(ctx.destination);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  _tone(freq, start, dur, { type = 'sine', gain = 0.5, attack = 0.01, to = null, detune = 0 } = {}) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (to) o.frequency.exponentialRampToValueAtTime(to, start + dur);
    o.detune.value = detune;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(this.out);
    o.start(start);
    o.stop(start + dur + 0.05);
  }

  _noise(start, dur, { from = 800, to = 4000, q = 1.2, gain = 0.3, type = 'bandpass' } = {}) {
    const c = this.ctx;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, start);
    f.frequency.exponentialRampToValueAtTime(to, start + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    s.connect(f).connect(g).connect(this.out);
    s.start(start);
    s.stop(start + dur + 0.05);
  }

  _ok() {
    return this.enabled && this.ctx.state === 'running';
  }

  // Ligando: varredura grave que abre num acorde
  boot() {
    if (!this._ok()) return;
    const t = this.ctx.currentTime + 0.02;
    this._tone(55, t, 1.3, { type: 'sawtooth', gain: 0.05, attack: 0.5, to: 110 });
    this._noise(t, 1.1, { from: 200, to: 6000, q: 0.8, gain: 0.08 });
    [659.25, 987.77, 1318.5].forEach((f, i) => this._tone(f, t + 0.85 + i * 0.07, 1.6, { gain: 0.16 - i * 0.03, attack: 0.02 }));
    this._tone(329.63, t + 0.85, 1.8, { type: 'triangle', gain: 0.1, attack: 0.03 });
  }

  // Ouvi você: dois toques curtinhos
  ack() {
    if (!this._ok()) return;
    const t = this.ctx.currentTime + 0.01;
    this._tone(880, t, 0.09, { gain: 0.12 });
    this._tone(1318.5, t + 0.07, 0.12, { gain: 0.1 });
  }

  // Holograma se montando: brilho que sobe
  materialize() {
    if (!this._ok()) return;
    const t = this.ctx.currentTime + 0.01;
    this._noise(t, 1.0, { from: 600, to: 5200, q: 2.5, gain: 0.07 });
    [1046.5, 1318.5, 1568, 2093].forEach((f, i) => this._tone(f, t + 0.12 + i * 0.11, 0.35, { gain: 0.05, attack: 0.005 }));
  }

  // Modelo jogado fora: "vush" descendo
  dismiss() {
    if (!this._ok()) return;
    const t = this.ctx.currentTime + 0.01;
    this._noise(t, 0.45, { from: 3500, to: 300, q: 1.5, gain: 0.12 });
  }

  error() {
    if (!this._ok()) return;
    const t = this.ctx.currentTime + 0.01;
    this._tone(392, t, 0.16, { type: 'triangle', gain: 0.12 });
    this._tone(293.66, t + 0.14, 0.24, { type: 'triangle', gain: 0.12 });
  }

  // Carinho no robô: dois bipes alegres subindo
  chirp() {
    if (!this._ok()) return;
    const t = this.ctx.currentTime + 0.01;
    this._tone(1200, t, 0.1, { gain: 0.08, to: 1800 });
    this._tone(1500, t + 0.09, 0.14, { gain: 0.08, to: 2400 });
  }

  // Timer terminou: carrilhão de três notas, duas vezes
  chime() {
    if (!this._ok()) return;
    const t = this.ctx.currentTime + 0.01;
    for (let r = 0; r < 2; r++) {
      [783.99, 1046.5, 1318.5].forEach((f, i) => this._tone(f, t + r * 0.9 + i * 0.16, 0.7, { gain: 0.14 }));
    }
  }
}
