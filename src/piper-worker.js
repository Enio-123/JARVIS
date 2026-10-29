// Voz Piper (neural, pt-BR) rodando num Worker: a síntese não trava a animação da página.
// Recebe { type: 'load' | 'synth', url, id, text } e devolve o áudio como Float32Array.
const base = new URL('../', self.location.href);
importScripts(new URL('vendor/ort/ort.wasm.min.js', base).href, new URL('vendor/piper/piper_phonemize.js', base).href);

const CACHE = 'jarvisvoz-piper-v1';
let ready = null;
let session = null;
let cfg = null;
let wasm = null;
let data = null;
let queue = Promise.resolve();

async function fetchCached(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* sem Cache API */ }
  const hit = await cache?.match(url);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Não consegui baixar a voz (erro ${res.status}).`);
  const total = +res.headers.get('Content-Length') || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onProgress && total && got - last > total / 100) { last = got; onProgress(got / total); }
  }
  const blob = new Blob(chunks);
  await cache?.put(url, new Response(blob)).catch(() => {});
  return blob.arrayBuffer();
}

async function load(url) {
  ort.env.wasm.wasmPaths = new URL('vendor/ort/', base).href;
  ort.env.wasm.numThreads = 1; // GitHub Pages não libera SharedArrayBuffer
  const [w, d, c] = await Promise.all([
    fetch(new URL('vendor/piper/piper_phonemize.wasm', base)).then((r) => r.arrayBuffer()),
    fetch(new URL('vendor/piper/piper_phonemize.data', base)).then((r) => r.arrayBuffer()),
    fetchCached(url + '.json').then((b) => JSON.parse(new TextDecoder().decode(b))),
  ]);
  wasm = w;
  data = d;
  cfg = c;
  const model = await fetchCached(url, (p) => postMessage({ type: 'progress', p }));
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
}

function phonemize(text) {
  return new Promise((resolve, reject) => {
    let done = false;
    self.createPiperPhonemize({
      wasmBinary: wasm,
      getPreloadedPackage: () => data.slice(0),
      locateFile: (u) => new URL('vendor/piper/' + u.split('/').pop(), base).href,
      print: (line) => {
        if (done) return;
        try { done = true; resolve(JSON.parse(line).phoneme_ids); } catch (e) { reject(e); }
      },
      printErr: () => {},
    }).then((mod) => {
      mod.callMain(['-l', cfg.espeak.voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
      if (!done) setTimeout(() => { if (!done) reject(new Error('Falha ao converter o texto em fonemas.')); }, 4000);
    }, reject);
  });
}

async function synth(text) {
  const ids = await phonemize(text);
  const inf = cfg.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, (v) => BigInt(v)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, inf.length_scale ?? 1, inf.noise_w ?? 0.8]), [3]),
  };
  if ((cfg.num_speakers || 1) > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  const out = await session.run(feeds);
  const first = out.output || out[Object.keys(out)[0]];
  return new Float32Array(first.data);
}

self.onmessage = (e) => {
  const m = e.data;
  queue = queue.then(async () => {
    try {
      ready ||= load(m.url).catch((err) => { ready = null; throw err; });
      await ready;
      if (m.type === 'load') return postMessage({ type: 'ready' });
      const pcm = await synth(m.text);
      postMessage({ type: 'audio', id: m.id, pcm, rate: cfg.audio.sample_rate }, [pcm.buffer]);
    } catch (err) {
      postMessage({ type: 'error', id: m.id, message: err.message || String(err) });
    }
  });
};
