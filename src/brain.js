// Conversa com a Groq: transcrição da fala (Whisper) e respostas do JARVIS (LLM com saída em JSON).
const API = 'https://api.groq.com/openai/v1';

// Ordem de preferência; o primeiro que a chave tiver acesso é usado.
const PREFERRED = [
  'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'llama-3.1-8b-instant',
];
const STT_MODEL = 'whisper-large-v3-turbo';

export class GroqError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function explain(status, body) {
  if (status === 401) return 'A chave da Groq foi recusada. Confira se copiou a chave inteira.';
  if (status === 429) return 'A Groq atingiu o limite de uso por agora. Espere alguns segundos e fale de novo.';
  if (status === 413) return 'O áudio ficou grande demais. Fale em partes menores.';
  if (status >= 500) return 'A Groq está instável agora. Tente de novo em instantes.';
  return body?.error?.message || `Erro ${status} na Groq.`;
}

async function call(key, path, init) {
  let res;
  try {
    res = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init.headers || {}) } });
  } catch {
    throw new GroqError(0, 'Sem conexão com a Groq. Verifique a internet.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new GroqError(res.status, explain(res.status, body));
  return body;
}

// Descobre qual modelo de conversa usar com esta chave
export async function pickModel(key) {
  const body = await call(key, '/models', { method: 'GET' });
  const ids = new Set((body?.data || []).filter((m) => m.active !== false).map((m) => m.id));
  const chosen = PREFERRED.find((id) => ids.has(id));
  if (!chosen) throw new GroqError(0, 'A chave funciona, mas nenhum modelo de conversa conhecido está disponível nela.');
  if (!ids.has(STT_MODEL) && !ids.has('whisper-large-v3')) throw new GroqError(0, 'A chave funciona, mas o Whisper (transcrição de voz) não está disponível nela.');
  return { chat: chosen, stt: ids.has(STT_MODEL) ? STT_MODEL : 'whisper-large-v3' };
}

// Frases que o Whisper costuma "inventar" em silêncio ou ruído
const HALLUCINATIONS = /amara\.org|legendas? (pela|por)|inscreva-se|obrigad[oa] por assistir|zanotto|^\W*(obrigad[oa]|tchau|valeu|hum+|ah+)\W*$/i;

export async function transcribe(key, model, wav) {
  const form = new FormData();
  form.append('file', wav, 'fala.wav');
  form.append('model', model);
  form.append('language', 'pt');
  form.append('temperature', '0');
  form.append('response_format', 'verbose_json');
  const body = await call(key, '/audio/transcriptions', { method: 'POST', body: form });
  const segs = body?.segments || [];
  // Descarta trechos que o Whisper marca como provavelmente sem fala
  const kept = segs.length ? segs.filter((s) => !(s.no_speech_prob > 0.6 && s.avg_logprob < -0.5)) : null;
  const text = (kept ? kept.map((s) => s.text).join(' ') : body?.text || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 2 || HALLUCINATIONS.test(text)) return '';
  return text;
}

const SHAPES = ['caixa', 'esfera', 'cilindro', 'cone', 'piramide', 'toro', 'capsula'];

function systemPrompt(name, sceneDesc) {
  const call = name?.trim() || 'senhor';
  return `Você é o JARVIS, assistente de inteligência artificial por voz, inspirado no assistente do Homem de Ferro: educado, inteligente, com humor britânico sutil e direto ao ponto. Você conversa em português do Brasil e chama o usuário de "${call}" de vez em quando, sem exagero.

Tudo o que você escreve em "fala" será lido em voz alta por um sintetizador. Por isso:
- Fale de forma natural, como numa conversa, com 1 a 4 frases curtas (no máximo uns 60 palavras), a não ser que o usuário peça explicação longa.
- Nada de markdown, listas, emojis, URLs, símbolos ou fórmulas escritas. Escreva números e unidades por extenso quando ajudar a leitura ("vinte e cinco graus").
- Não diga que é um modelo de linguagem; você é o JARVIS.

Você também tem um projetor 3D. Sempre que o assunto puder ser visualizado (objetos, lugares, planetas, átomos, máquinas, animais, corpo humano, construções, conceitos de física, geometria, etc.), monte um modelo 3D SIMPLIFICADO feito de formas básicas. O usuário pega e gira o modelo com as mãos, então capriche na composição: proporções reconhecíveis, cores coerentes, peças com nomes úteis. Em conversa casual ou sem nada visual, não gere modelo.

Responda SEMPRE com um único objeto JSON válido, neste formato:
{
  "fala": "o que você diz em voz alta",
  "cena": "manter" | "nova" | "adicionar" | "limpar",
  "modelo": null ou {
    "nome": "nome curto do modelo",
    "partes": [
      { "nome": "nome da peça", "forma": "${SHAPES.join('" | "')}", "tam": [largura, altura, profundidade], "pos": [x, y, z], "rot": [graus_x, graus_y, graus_z], "cor": "#rrggbb", "brilho": false, "giro": 0, "orbita": 0 }
    ]
  }
}

Regras do modelo 3D:
- "cena": "nova" troca o que está no projetor; "adicionar" coloca ao lado do que já existe (para comparar); "manter" não mexe; "limpar" apaga tudo (use quando pedirem). Com "manter" ou "limpar", "modelo" é null.
- Unidades livres, mas mantenha o modelo inteiro entre -5 e 5 em cada eixo, centrado na origem; y é para cima. Ele é redimensionado automaticamente.
- "tam" é o tamanho total da peça em cada eixo. Esfera: use os três iguais (o diâmetro). Cilindro, cone, pirâmide e cápsula ficam em pé no eixo y. Toro: largura e profundidade = diâmetro externo, altura = espessura do tubo; ele fica deitado no plano xz (use "rot" para inclinar).
- Use de 3 a 30 peças. Cada peça precisa de um "nome" em português.
- "brilho": true só para coisas que emitem luz (Sol, lâmpada, fogo, tela).
- "giro": voltas por segundo da peça em torno do próprio eixo y (ex.: 0.1 para um planeta girando, 0.5 para uma hélice). 0 = parada.
- "orbita": voltas por segundo da peça em torno do eixo y da origem do modelo (planetas ao redor do Sol, elétrons ao redor do núcleo). 0 = sem órbita. Para órbitas, a peça precisa estar afastada da origem.
- Se o usuário pedir para mudar o modelo atual (cor, adicionar peça, aumentar algo), devolva o modelo completo atualizado com "cena": "nova".

${sceneDesc ? `No projetor agora: ${sceneDesc}.` : 'O projetor está vazio agora.'}`;
}

export class Brain {
  constructor() {
    this.history = [];
  }

  reset() {
    this.history = [];
  }

  async reply({ key, model, text, name, sceneDesc, signal }) {
    this.history.push({ role: 'user', content: text });
    if (this.history.length > 16) this.history.splice(0, this.history.length - 16);
    const body = {
      model,
      messages: [{ role: 'system', content: systemPrompt(name, sceneDesc) }, ...this.history],
      temperature: 0.6,
      max_completion_tokens: 3000,
      response_format: { type: 'json_object' },
    };
    if (model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';
    let res;
    try {
      res = await call(key, '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      this.history.pop();
      throw e;
    }
    const content = res?.choices?.[0]?.message?.content || '';
    const out = parseReply(content);
    // No histórico guardamos só o essencial, para gastar menos tokens
    this.history.push({
      role: 'assistant',
      content: JSON.stringify({ fala: out.fala, cena: out.cena, modelo: out.modelo ? { nome: out.modelo.nome, partes: `${out.modelo.partes.length} peças` } : null }),
    });
    return out;
  }
}

export function parseReply(content) {
  let data = null;
  try {
    data = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) { try { data = JSON.parse(m[0]); } catch { /* ignora */ } }
  }
  if (!data || typeof data !== 'object') return { fala: cleanSpeech(content), cena: 'manter', modelo: null };
  const cena = ['manter', 'nova', 'adicionar', 'limpar'].includes(data.cena) ? data.cena : (data.modelo ? 'nova' : 'manter');
  const modelo = sanitizeModel(data.modelo);
  return { fala: cleanSpeech(String(data.fala || '')), cena: modelo || cena === 'limpar' ? cena : 'manter', modelo };
}

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const vec = (v, d) => (Array.isArray(v) ? [0, 1, 2].map((i) => num(v[i], d[i])) : d);

export function sanitizeModel(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.partes)) return null;
  const partes = m.partes.slice(0, 40).map((p, i) => ({
    nome: String(p?.nome || `Peça ${i + 1}`).slice(0, 40),
    forma: SHAPES.includes(normalizeShape(p?.forma)) ? normalizeShape(p.forma) : 'caixa',
    tam: vec(p?.tam, [1, 1, 1]).map((v) => Math.min(20, Math.max(0.02, Math.abs(v)))),
    pos: vec(p?.pos, [0, 0, 0]).map((v) => Math.min(20, Math.max(-20, v))),
    rot: vec(p?.rot, [0, 0, 0]),
    cor: /^#[0-9a-f]{6}$/i.test(p?.cor) ? p.cor : '#9aa4b2',
    brilho: !!p?.brilho,
    giro: Math.max(-3, Math.min(3, num(p?.giro))),
    orbita: Math.max(-2, Math.min(2, num(p?.orbita))),
  }));
  if (!partes.length) return null;
  return { nome: String(m.nome || 'Modelo').slice(0, 50), partes };
}

function normalizeShape(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Tira o que não deve ser lido em voz alta
export function cleanSpeech(t) {
  return t
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#`>|~]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
