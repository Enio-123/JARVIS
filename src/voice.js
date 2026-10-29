// Voz do JARVIS. Quatro motores, do mais realista ao mais simples:
// - piper: Piper TTS (neural, pt-BR "faber") rodando num Worker; baixa 63 MB uma vez e guarda em cache
// - eleven: ElevenLabs (nuvem, precisa de chave), voz pronta "Daniel" por padrão
// - microsoft: vozes neurais "Natural" que o Edge oferece
// - sistema: melhor voz em português que o navegador tiver
// A fala chega frase por frase (streaming): a próxima frase é sintetizada enquanto a atual toca.
const PIPER_VOICE = {
  url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx',
  size: 63,
};
export const PIPER_CACHE = 'jarvisvoz-piper-v1';

export const ENGINE_LABELS = {
  piper: 'Piper Faber (neural, no navegador)',
  eleven: 'ElevenLabs (a mais realista, precisa de chave)',
  microsoft: 'Microsoft neural (Edge)',
  sistema: 'Voz do sistema',
  auto: 'Automática (a melhor disponível)',
};

// Divide um texto pronto em frases
export function sentences(text) {
  const parts = text.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [text];
  const out = [];
  for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
    if (out.length && (p.length < 18 || out[out.length - 1].length < 18)) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out;
}

function waitVoices() {
  if (!('speechSynthesis' in window)) return Promise.resolve([]);
  if (speechSynthesis.getVoices().length) return Promise.resolve(speechSynthesis.getVoices());
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

function pickMicrosoft(voices) {
  const pt = voices.filter((v) => /^pt[-_]BR/i.test(v.lang) && /microsoft/i.test(v.name) && /natural|online/i.test(v.name));
  return pt.find((v) => /antonio/i.test(v.name)) || pt.find((v) => /donato|fabio|humberto|julio|nicolau|valerio/i.test(v.name)) || pt[0] || null;
}

function pickSystem(voices) {
  const br = voices.filter((v) => /^pt[-_]BR/i.test(v.lang));
  return br.find((v) => /google/i.test(v.name)) || br.find((v) => /natural|online|neural|premium|enhanced/i.test(v.name))
    || br.find((v) => !v.localService) || br[0] || voices.find((v) => /^pt/i.test(v.lang)) || null;
}

// ---------- Piper (no Worker) ----------
class PiperClient {
  constructor() {
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.loading = null;
    this.onProgress = () => {};
  }

  _ensure() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./piper-worker.js', import.meta.url));
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') return this.onProgress(m.p);
      if (m.type === 'ready') { this.loading?.resolve(); return; }
      const p = this.pending.get(m.id);
      if (m.type === 'audio' && p) { this.pending.delete(m.id); p.resolve(m); return; }
      if (m.type === 'error') {
        if (p) { this.pending.delete(m.id); p.reject(new Error(m.message)); } else this.loading?.reject(new Error(m.message));
      }
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Falha no motor da voz.');
      this.loading?.reject(err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
    };
  }

  load() {
    this._ensure();
    if (!this.loading) {
      let resolve, reject;
      const promise = new Promise((a, b) => { resolve = a; reject = b; });
      this.loading = { promise, resolve, reject };
      promise.catch(() => { this.loading = null; });
      this.worker.postMessage({ type: 'load', url: PIPER_VOICE.url });
    }
    return this.loading.promise;
  }

  async synth(text, ctx) {
    this._ensure();
    const id = ++this.seq;
    const m = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'synth', url: PIPER_VOICE.url, id, text });
    });
    const buf = ctx.createBuffer(1, m.pcm.length, m.rate);
    buf.copyToChannel(m.pcm, 0);
    return buf;
  }
}

// ---------- ElevenLabs ----------
export async function elevenVoices(key) {
  const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
  if (res.status === 401) throw new Error('A chave da ElevenLabs foi recusada.');
  if (!res.ok) throw new Error(`Erro ${res.status} na ElevenLabs.`);
  const body = await res.json();
  return (body.voices || []).map((v) => ({ id: v.voice_id, name: v.name, desc: [v.labels?.accent, v.labels?.gender].filter(Boolean).join(', ') }));
}

async function elevenSynth(key, voiceId, text, ctx, prev) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      previous_text: prev || undefined,
      voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const status = body?.detail?.status || '';
    if (res.status === 401 && /quota/i.test(status)) throw new Error('Acabaram os caracteres do mês na ElevenLabs.');
    if (res.status === 401) throw new Error('A chave da ElevenLabs foi recusada.');
    throw new Error(body?.detail?.message || `Erro ${res.status} na ElevenLabs.`);
  }
  return ctx.decodeAudioData(await res.arrayBuffer());
}

const BUFFER_ENGINES = new Set(['piper', 'eleven']);

// ---------- Voz ----------
export class Voice {
  constructor(ctx) {
    this.ctx = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.connect(ctx.destination);
    this.wave = new Float32Array(this.analyser.fftSize);
    this.piper = new PiperClient();
    this.voices = [];
    this.speakingNow = false;
    this.mode = 'buffer';
    this.fake = 0;
    this.token = 0;
    this.piperCached = false;
    this.onNote = () => {};
    this.now = null; // frase que está tocando: { index, text, meta, start, duration, chars }
  }

  async init() {
    this.voices = await waitVoices();
    try {
      const c = await caches.open(PIPER_CACHE);
      this.piperCached = !!(await c.match(PIPER_VOICE.url)) && !!(await c.match(PIPER_VOICE.url + '.json'));
    } catch { this.piperCached = false; }
  }

  available(settings) {
    return {
      piper: typeof WebAssembly === 'object' && typeof Worker === 'function',
      eleven: !!settings.elevenKey,
      microsoft: !!pickMicrosoft(this.voices),
      sistema: 'speechSynthesis' in window,
    };
  }

  // Motor que será usado de fato com as configurações atuais
  resolve(settings) {
    const a = this.available(settings);
    if (settings.voice !== 'auto' && a[settings.voice]) return settings.voice;
    return ['eleven', 'microsoft', 'piper', 'sistema'].find((k) => a[k]) || 'sistema';
  }

  describe(engine) {
    if (engine === 'microsoft') return pickMicrosoft(this.voices)?.name || '';
    if (engine === 'sistema') return pickSystem(this.voices)?.name || 'padrão do navegador';
    if (engine === 'piper') return this.piperCached ? 'voz baixada e pronta' : `baixa ${PIPER_VOICE.size} MB na primeira vez`;
    return '';
  }

  level() {
    if (!this.speakingNow) return 0;
    if (this.mode === 'speech') {
      this.fake += 0.25;
      return 0.25 + 0.2 * Math.abs(Math.sin(this.fake) * Math.sin(this.fake * 0.37));
    }
    this.analyser.getFloatTimeDomainData(this.wave);
    let s = 0;
    for (const v of this.wave) s += v * v;
    return Math.min(1, Math.sqrt(s / this.wave.length) * 4);
  }

  // Quanto da frase atual já foi falado (0 a 1), para a legenda acompanhar a voz
  progress() {
    const n = this.now;
    if (!n) return 0;
    if (n.boundary != null) return Math.min(1, n.boundary / Math.max(1, n.chars));
    const d = n.duration || n.chars * 0.068;
    const t = this.mode === 'speech' ? (performance.now() - n.start) / 1000 : this.ctx.currentTime - n.start;
    return Math.max(0, Math.min(1, t / d));
  }

  stop() {
    this.token++;
    try { this.source?.stop(); } catch { /* já parado */ }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.speakingNow = false;
    this.now = null;
    this.wakeQueue?.();
  }

  preparePiper() {
    if (this.piperLoading) return this.piperLoading;
    this.piper.onProgress = (p) => this.onNote(`Baixando a voz do JARVIS (${PIPER_VOICE.size} MB, só na primeira vez): ${Math.round(p * 100)}%`);
    this.piperLoading = this.piper.load().then(
      () => { this.piperCached = true; this.onNote(''); return true; },
      (e) => {
        this.piperFailedAt = performance.now();
        this.onNote(`A voz neural não carregou (${e.message}). Usando a voz do sistema.`);
        return false;
      },
    ).finally(() => { this.piperLoading = null; });
    return this.piperLoading;
  }

  // Começa uma fala em streaming. push(texto) para cada frase; end() quando acabar.
  begin(settings, handlers = {}) {
    this.stop();
    const token = ++this.token;
    let engine = this.resolve(settings);
    if (engine === 'piper' && !this.piperCached) {
      // enquanto a voz neural baixa, fala com outra e prepara o Piper em segundo plano
      // (se o download acabou de falhar, espera um pouco antes de tentar de novo)
      if (!this.piperFailedAt || performance.now() - this.piperFailedAt > 120000) this.preparePiper();
      engine = this.available(settings).microsoft ? 'microsoft' : 'sistema';
    }
    const items = [];
    let ended = false;
    const synth = (it, i) => {
      const p = engine === 'eleven'
        ? elevenSynth(settings.elevenKey, settings.elevenVoice, it.text, this.ctx, items[i - 1]?.text)
        : this.piper.synth(it.text, this.ctx);
      p.catch(() => {});
      return p;
    };
    const sp = {
      push: (text, meta) => {
        if (token !== this.token || !text) return;
        const it = { text, meta };
        items.push(it);
        if (BUFFER_ENGINES.has(engine)) it.audio = synth(it, items.length - 1);
        this.wakeQueue?.();
      },
      end: () => { ended = true; this.wakeQueue?.(); },
    };
    sp.done = (async () => {
      let i = 0;
      while (token === this.token) {
        if (i >= items.length) {
          if (ended) break;
          await new Promise((r) => { this.wakeQueue = r; });
          this.wakeQueue = null;
          continue;
        }
        const it = items[i];
        try {
          if (BUFFER_ENGINES.has(engine)) {
            this.mode = 'buffer';
            const buf = await (it.audio || (it.audio = synth(it, i)));
            if (token !== this.token) break;
            this.now = { index: i, text: it.text, meta: it.meta, start: this.ctx.currentTime, duration: buf.duration, chars: it.text.length };
            handlers.onStart?.(i, it);
            await this._play(buf, token);
          } else {
            this.mode = 'speech';
            const voice = engine === 'microsoft' ? pickMicrosoft(this.voices) : pickSystem(this.voices);
            this.now = { index: i, text: it.text, meta: it.meta, start: performance.now(), duration: null, chars: it.text.length, boundary: null };
            handlers.onStart?.(i, it);
            await this._utter(it.text, voice, token);
          }
          i++;
        } catch (e) {
          if (token !== this.token) break;
          // falhou nesta frase: troca para a voz do sistema e repete a mesma frase
          this.onNote(`${e.message} Usando a voz do sistema.`);
          engine = 'sistema';
        }
      }
      if (token === this.token) { this.speakingNow = false; this.now = null; }
    })();
    return sp;
  }

  // Atalho para falar um texto pronto
  say(text, settings, handlers) {
    const sp = this.begin(settings, handlers);
    for (const s of sentences(text)) sp.push(s, { raw: s });
    sp.end();
    return sp.done;
  }

  _play(buf, token) {
    return new Promise((resolve) => {
      if (token !== this.token) return resolve();
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.analyser);
      src.onended = resolve;
      this.source = src;
      this.speakingNow = true;
      src.start();
    });
  }

  _utter(text, voice, token) {
    if (!('speechSynthesis' in window)) return Promise.reject(new Error('Este navegador não tem voz.'));
    return new Promise((resolve) => {
      if (token !== this.token) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = voice?.lang || 'pt-BR';
      if (voice) u.voice = voice;
      u.rate = 1.02;
      // o Chrome às vezes não dispara onend; o tempo limite evita travar
      const timer = setTimeout(resolve, 2500 + text.length * 110);
      u.onboundary = (e) => { if (this.now && token === this.token) this.now.boundary = e.charIndex + (e.charLength || 0); };
      u.onend = u.onerror = () => { clearTimeout(timer); resolve(); };
      this.speakingNow = true;
      speechSynthesis.speak(u);
    });
  }
}
