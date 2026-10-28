// Voz do JARVIS. Quatro motores, do mais realista ao mais simples:
// - eleven: ElevenLabs (nuvem, precisa de chave), voz pronta "Daniel" por padrão
// - microsoft: vozes neurais "Natural" da Microsoft que o Edge expõe no speechSynthesis
// - piper: Piper TTS rodando no navegador (ONNX), voz pt_BR "faber", baixada uma vez e guardada em cache
// - sistema: melhor voz em português que o navegador tiver
const PIPER_VOICE = {
  id: 'pt_BR-faber-medium',
  url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx',
  size: 63,
};
const PIPER_CACHE = 'jarvisvoz-piper-v1';
const base = new URL('../', import.meta.url);

export const ENGINE_LABELS = {
  auto: 'Automática (a melhor disponível)',
  eleven: 'ElevenLabs (mais realista)',
  microsoft: 'Microsoft neural (Edge)',
  piper: 'Piper Faber (neural, no navegador)',
  sistema: 'Voz do sistema',
};

// Divide em frases para começar a falar antes de sintetizar tudo
export function sentences(text) {
  const parts = text.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [text];
  const out = [];
  for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
    // junta frases muito curtas com a anterior, para não picotar a entonação
    if (out.length && (p.length < 18 || out[out.length - 1].length < 18)) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out;
}

function waitVoices() {
  const has = () => speechSynthesis.getVoices().length > 0;
  if (!('speechSynthesis' in window)) return Promise.resolve([]);
  if (has()) return Promise.resolve(speechSynthesis.getVoices());
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

// ---------- Piper no navegador ----------
class Piper {
  constructor() {
    this.ready = null;
    this.onProgress = () => {};
  }

  async isCached() {
    try {
      const c = await caches.open(PIPER_CACHE);
      return !!(await c.match(PIPER_VOICE.url)) && !!(await c.match(PIPER_VOICE.url + '.json'));
    } catch { return false; }
  }

  load() {
    this.ready ||= this._load().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  async _fetchCached(url, progress) {
    let cache = null;
    try { cache = await caches.open(PIPER_CACHE); } catch { /* sem Cache API */ }
    const hit = await cache?.match(url);
    if (hit) return hit.arrayBuffer();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Não consegui baixar a voz (${res.status}).`);
    const total = +res.headers.get('Content-Length') || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      progress?.(total ? got / total : 0);
    }
    const blob = new Blob(chunks);
    await cache?.put(url, new Response(blob)).catch(() => {});
    return blob.arrayBuffer();
  }

  async _load() {
    if (!window.ort) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = new URL('vendor/ort/ort.wasm.min.js', base).href;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Falha ao carregar o motor da voz.'));
        document.head.append(s);
      });
    }
    const ort = window.ort;
    ort.env.wasm.wasmPaths = new URL('vendor/ort/', base).href;
    ort.env.wasm.numThreads = 1; // GitHub Pages não libera SharedArrayBuffer
    const [{ createPiperPhonemize }, wasm, data, cfg] = await Promise.all([
      import('../vendor/piper/piper_phonemize.mjs'),
      fetch(new URL('vendor/piper/piper_phonemize.wasm', base)).then((r) => r.arrayBuffer()),
      fetch(new URL('vendor/piper/piper_phonemize.data', base)).then((r) => r.arrayBuffer()),
      this._fetchCached(PIPER_VOICE.url + '.json').then((b) => JSON.parse(new TextDecoder().decode(b))),
    ]);
    const model = await this._fetchCached(PIPER_VOICE.url, (p) => this.onProgress(p));
    this.session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    Object.assign(this, { ort, createPiperPhonemize, wasm, data, cfg });
  }

  phonemize(text) {
    return new Promise((resolve, reject) => {
      let done = false;
      this.createPiperPhonemize({
        wasmBinary: this.wasm,
        getPreloadedPackage: () => this.data.slice(0),
        locateFile: (u) => new URL('vendor/piper/' + u.split('/').pop(), base).href,
        print: (line) => {
          if (done) return;
          try { done = true; resolve(JSON.parse(line).phoneme_ids); } catch (e) { reject(e); }
        },
        printErr: () => {},
      }).then((mod) => {
        mod.callMain(['-l', this.cfg.espeak.voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
        if (!done) setTimeout(() => !done && reject(new Error('Falha ao converter o texto em fonemas.')), 3000);
      }, reject);
    });
  }

  async synth(text, ctx) {
    await this.load();
    const ids = await this.phonemize(text);
    const { ort, cfg } = this;
    const inf = cfg.inference || {};
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, inf.length_scale ?? 1, inf.noise_w ?? 0.8]), [3]),
    };
    if (cfg.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
    const out = await this.session.run(feeds);
    const pcm = out.output.data;
    const buf = ctx.createBuffer(1, pcm.length, cfg.audio.sample_rate);
    buf.copyToChannel(pcm, 0);
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

async function elevenSynth(key, voiceId, text, ctx, prev, next) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      previous_text: prev || undefined,
      next_text: next || undefined,
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

// ---------- Voz ----------
export class Voice {
  constructor(ctx) {
    this.ctx = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.connect(ctx.destination);
    this.wave = new Float32Array(this.analyser.fftSize);
    this.piper = new Piper();
    this.voices = [];
    this.speakingNow = false;
    this.fake = 0;
    this.token = 0;
    this.onNote = () => {};
  }

  async init() {
    this.voices = await waitVoices();
    this.piperCached = await this.piper.isCached();
  }

  available(settings) {
    return {
      eleven: !!settings.elevenKey,
      microsoft: !!pickMicrosoft(this.voices),
      piper: typeof WebAssembly === 'object',
      sistema: !!pickSystem(this.voices) || 'speechSynthesis' in window,
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

  stop() {
    this.token++;
    try { this.source?.stop(); } catch { /* já parado */ }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.speakingNow = false;
  }

  // Fala o texto inteiro. Resolve quando termina (ou quando é interrompido).
  async speak(text, settings) {
    this.stop();
    const token = ++this.token;
    const parts = sentences(text);
    if (!parts.length) return;
    let engine = this.resolve(settings);

    if (engine === 'piper' && !this.piperCached) {
      // Enquanto a voz neural baixa, fala com a voz do sistema e prepara o Piper em segundo plano
      this.preparePiper();
      engine = 'sistema';
    }

    try {
      if (engine === 'eleven') return await this._speakBuffers(token, parts, (t, i) =>
        elevenSynth(settings.elevenKey, settings.elevenVoice, t, this.ctx, parts[i - 1], parts[i + 1]));
      if (engine === 'piper') return await this._speakBuffers(token, parts, (t) => this.piper.synth(t, this.ctx));
      return await this._speakSpeech(token, parts, engine === 'microsoft' ? pickMicrosoft(this.voices) : pickSystem(this.voices));
    } catch (e) {
      if (token !== this.token) return;
      this.onNote(`${e.message} Usando a voz do sistema.`);
      return this._speakSpeech(token, parts, pickSystem(this.voices));
    }
  }

  preparePiper() {
    if (this.piperLoading) return this.piperLoading;
    this.piper.onProgress = (p) => this.onNote(`Baixando a voz neural (${PIPER_VOICE.size} MB, só na primeira vez): ${Math.round(p * 100)}%`);
    this.piperLoading = this.piper.load().then(
      () => { this.piperCached = true; this.onNote(''); },
      (e) => { this.onNote(`Voz neural indisponível: ${e.message}`); },
    ).finally(() => { this.piperLoading = null; });
    return this.piperLoading;
  }

  async _speakBuffers(token, parts, synth) {
    this.mode = 'buffer';
    // sintetiza a próxima frase enquanto toca a atual
    let next = synth(parts[0], 0);
    for (let i = 0; i < parts.length; i++) {
      const buf = await next;
      if (token !== this.token) return;
      if (i + 1 < parts.length) next = synth(parts[i + 1], i + 1);
      await this._play(buf, token);
      if (token !== this.token) return;
    }
    this.speakingNow = false;
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

  async _speakSpeech(token, parts, voice) {
    if (!('speechSynthesis' in window)) throw new Error('Este navegador não tem voz.');
    this.mode = 'speech';
    for (const p of parts) {
      if (token !== this.token) return;
      await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(p);
        u.lang = voice?.lang || 'pt-BR';
        if (voice) u.voice = voice;
        u.rate = 1.02;
        // o Chrome às vezes não dispara onend; o tempo limite evita travar
        const timer = setTimeout(resolve, 2500 + p.length * 120);
        u.onend = u.onerror = () => { clearTimeout(timer); resolve(); };
        this.speakingNow = true;
        speechSynthesis.speak(u);
      });
    }
    if (token === this.token) this.speakingNow = false;
  }
}
