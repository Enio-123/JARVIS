// Microfone sempre ligado com detecção de fala (VAD por energia com piso de ruído adaptativo).
// Quando a pessoa termina de falar, entrega o trecho como WAV 16 kHz (pequeno e aceito pelo Whisper).
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('jarvis-tap', Tap);
`;

const FRAME_MS = 20;
const PREROLL_MS = 400;
const END_SILENCE_MS = 850;
const MIN_SPEECH_MS = 300;
const MAX_UTTERANCE_MS = 25000;
// Falando por cima do JARVIS: corta mais cedo e manda uma prévia logo no começo,
// para o "Jarvis" ser reconhecido enquanto a pessoa ainda fala
const BARGE_SILENCE_MS = 550;
const BARGE_MAX_MS = 7000;
const EARLY_MS = 700;

export class Ear {
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = false;
    this.onUtterance = () => {};
    this.onLevel = () => {};
    this.onSpeechStart = () => {};
    this.onSpeechEnd = () => {}; // trecho curto demais, descartado
    this.sensitivity = 1; // > 1 exige voz mais alta (ex.: com música tocando)
    this.maxMs = MAX_UTTERANCE_MS;
    this.floor = 0.004;
    this.level = 0;
    // Modo "por cima": o JARVIS está falando e o microfone só procura alguém chamando por ele
    this.barge = false;
    this.bargeBoost = 1; // sobe quando o eco engana o detector, para errar menos
    this.refLevel = null; // () => volume que está saindo nos alto-falantes (-1 se desconhecido)
    this.echo = 0.25; // quanto do som de saída volta pelo microfone (aprendido)
    this.refHist = new Float32Array(10);
    this.refIdx = 0;
    this.onEarly = null;
    this._reset();
  }

  _reset() {
    this.frames = []; // quadros de 20 ms (Float32Array)
    this.speaking = false;
    this.voicedMs = 0;
    this.silentMs = 0;
    this.totalMs = 0;
    this.onRun = 0;
    this.earlySent = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'jarvis-tap');
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.src.connect(this.node).connect(mute).connect(this.ctx.destination);
    this.frameLen = Math.round((this.ctx.sampleRate * FRAME_MS) / 1000);
    this.pending = new Float32Array(0);
    this.node.port.onmessage = (e) => this._push(e.data);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect();
    this.src?.disconnect();
    this.stream = null;
  }

  get active() {
    return !!this.stream;
  }

  setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    this._reset();
  }

  // Ao sair do modo "por cima" no meio de uma fala, a fala continua sendo gravada
  setBarge(on) {
    if (on === this.barge) return;
    this.barge = on;
    if (on && !this.speaking) this._reset();
  }

  _push(chunk) {
    const buf = new Float32Array(this.pending.length + chunk.length);
    buf.set(this.pending);
    buf.set(chunk, this.pending.length);
    let i = 0;
    for (; i + this.frameLen <= buf.length; i += this.frameLen) this._frame(buf.slice(i, i + this.frameLen));
    this.pending = buf.slice(i);
  }

  _frame(f) {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length);
    this.level += (rms - this.level) * 0.3;
    this.onLevel(this.level);

    // Enquanto o JARVIS fala, o microfone também capta a voz dele (o eco que o cancelamento não tirou).
    // Guarda o pico do que saiu nos últimos 200 ms e aprende quanto disso volta pelo microfone.
    let refPeak = 0;
    let refKnown = true;
    if (this.barge) {
      const r = this.refLevel ? this.refLevel() : -1;
      refKnown = r >= 0;
      this.refHist[this.refIdx++ % this.refHist.length] = Math.max(0, r);
      for (const v of this.refHist) if (v > refPeak) refPeak = v;
      if (refKnown && !this.speaking && this.onRun === 0 && refPeak > 0.003) {
        const ratio = Math.min(2, rms / refPeak);
        this.echo += (ratio - this.echo) * (ratio > this.echo ? 0.05 : 0.03);
      }
    } else {
      this.refHist.fill(0);
      // Piso de ruído: desce rápido e sobe devagar (só quando não há fala)
      if (!this.speaking) this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.998 + rms * 0.002;
      this.floor = Math.max(this.floor, 0.0015);
    }
    if (!this.enabled) return;

    let startT = Math.max(this.floor * 3.2, 0.012) * this.sensitivity;
    let keepT = Math.max(this.floor * 2, 0.008);
    if (this.barge) {
      // para chamar o JARVIS enquanto ele fala, a voz precisa se destacar do eco dele
      const echoT = refPeak * this.echo * 2.4;
      startT = Math.max(startT * (refKnown ? 1.3 : 2.4), echoT) * this.bargeBoost;
      keepT = Math.max(keepT, echoT * 0.6);
    }

    this.frames.push(f);
    if (!this.speaking) {
      // mantém só o pré-roll enquanto ninguém fala
      const max = Math.ceil(PREROLL_MS / FRAME_MS);
      if (this.frames.length > max) this.frames.shift();
      this.onRun = rms > startT ? this.onRun + 1 : 0;
      if (this.onRun >= (this.barge ? 6 : 3)) {
        this.speaking = true;
        this.voicedMs = this.onRun * FRAME_MS;
        this.silentMs = 0;
        this.totalMs = this.frames.length * FRAME_MS;
        this.onSpeechStart();
      }
      return;
    }
    this.totalMs += FRAME_MS;
    if (rms > keepT) {
      this.voicedMs += FRAME_MS;
      this.silentMs = 0;
    } else {
      this.silentMs += FRAME_MS;
    }
    if (this.barge && !this.earlySent && this.voicedMs >= EARLY_MS) {
      this.earlySent = true;
      this.onEarly?.(toWav(this.frames, this.ctx.sampleRate));
    }
    const endSilence = this.barge ? BARGE_SILENCE_MS : END_SILENCE_MS;
    const maxMs = this.barge ? Math.min(this.maxMs, BARGE_MAX_MS) : this.maxMs;
    if (this.silentMs >= endSilence || this.totalMs >= maxMs) {
      const frames = this.frames;
      const voiced = this.voicedMs;
      this._reset();
      if (voiced >= MIN_SPEECH_MS) this.onUtterance(toWav(frames, this.ctx.sampleRate));
      else this.onSpeechEnd();
    }
  }
}

// Junta os quadros, reamostra para 16 kHz e monta um WAV PCM 16 bits
export function toWav(frames, rate, target = 16000) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const pcm = new Float32Array(total);
  let o = 0;
  for (const f of frames) { pcm.set(f, o); o += f.length; }
  const ratio = rate / target;
  const n = Math.floor(total / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // média simples da janela (filtro anti-alias barato)
    const a = Math.floor(i * ratio), b = Math.min(total, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let k = a; k < b; k++) s += pcm[k];
    out[i] = s / Math.max(1, b - a);
  }
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (p, s) => { for (let i = 0; i < s.length; i++) view.setUint8(p + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, target, true); view.setUint32(28, target * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, out[i])) * 0x7fff, true);
  return new Blob([view.buffer], { type: 'audio/wav' });
}
