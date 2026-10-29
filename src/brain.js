// Conversa com a Groq: transcrição da fala (Whisper) e respostas do JARVIS com streaming.
// A resposta vem em duas partes: primeiro o texto falado (que já vai para a voz frase por frase,
// enquanto o resto ainda está sendo gerado) e depois, após "###", um JSON com os comandos
// (modelo 3D, música, timer, memória...).
import { trackList } from './music.js';
import { PREFAB_NAMES } from './anatomy.js';

const API = 'https://api.groq.com/openai/v1';

// Ordem de preferência. Se um modelo bater no limite de uso, a próxima tentativa usa o seguinte.
const PREFERRED = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
  'qwen/qwen3.8-27b',
  'llama-3.1-8b-instant',
];
const STT_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'];

export class GroqError extends Error {
  constructor(status, message, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function explain(status, body) {
  if (status === 401) return 'A chave da Groq foi recusada. Confira se copiou a chave inteira.';
  if (status === 429) return 'A Groq atingiu o limite de uso por agora. Espere alguns segundos.';
  if (status === 413) return 'O pedido ficou grande demais para o limite da Groq agora. Tente de novo em instantes.';
  if (status >= 500) return 'A Groq está instável agora. Tente de novo em instantes.';
  return body?.error?.message || `Erro ${status} na Groq.`;
}

async function call(key, path, init) {
  let res;
  try {
    res = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init.headers || {}) } });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new GroqError(0, 'Sem conexão com a Groq. Verifique a internet.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new GroqError(res.status, explain(res.status, body), +res.headers.get('retry-after') || 0);
  }
  return res;
}

// Descobre quais modelos esta chave pode usar
export async function pickModels(key) {
  const body = await (await call(key, '/models', { method: 'GET' })).json();
  const ids = new Set((body?.data || []).filter((m) => m.active !== false).map((m) => m.id));
  const chat = PREFERRED.filter((id) => ids.has(id));
  const stt = STT_MODELS.find((id) => ids.has(id));
  if (!chat.length) throw new GroqError(0, 'A chave funciona, mas nenhum modelo de conversa conhecido está disponível nela.');
  if (!stt) throw new GroqError(0, 'A chave funciona, mas o Whisper (transcrição de voz) não está disponível nela.');
  return { chat, stt };
}

// Frases que o Whisper costuma "inventar" em silêncio ou ruído
const HALLUCINATIONS = /amara\.org|legendas? (pela|por)|inscreva-se|obrigad[oa] por assistir|zanotto|^\W*(obrigad[oa]|tchau|valeu|hum+|ah+|e aí|é isso)\W*$/i;

export async function transcribe(key, model, wav, prompt = 'Conversa em português com o JARVIS.') {
  const form = new FormData();
  form.append('file', wav, 'fala.wav');
  form.append('model', model);
  form.append('language', 'pt');
  form.append('temperature', '0');
  form.append('response_format', 'verbose_json');
  form.append('prompt', prompt);
  const body = await (await call(key, '/audio/transcriptions', { method: 'POST', body: form })).json();
  const segs = body?.segments || [];
  // Descarta trechos que o Whisper marca como provavelmente sem fala
  const kept = segs.length ? segs.filter((s) => !(s.no_speech_prob > 0.6 && s.avg_logprob < -0.5)) : null;
  const text = (kept ? kept.map((s) => s.text).join(' ') : body?.text || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 2 || HALLUCINATIONS.test(text)) return '';
  return text;
}

const SHAPES = ['caixa', 'esfera', 'semiesfera', 'cilindro', 'cone', 'piramide', 'prisma', 'tubo', 'toro', 'capsula',
  'organico', 'curva', 'torno', 'extrusao', 'engrenagem', 'mola'];
const MATERIALS = ['plastico', 'fosco', 'metal', 'vidro', 'luz', 'holograma', 'tecido', 'osso'];

const SYSTEM = `Você é o J.A.R.V.I.S., o assistente de inteligência artificial do Homem de Ferro. Personalidade: educado, brilhante, leal, com humor britânico seco e sutil, confiante e direto. Fale sempre em português do Brasil.

COMO RESPONDER (obrigatório)
1. Primeiro escreva o que você vai FALAR em voz alta: texto corrido e natural, curto e direto, de 1 a 3 frases (no máximo umas 40 palavras). Só fale mais se o usuário pedir uma explicação detalhada. Nada de listas, markdown, emojis, URLs ou símbolos. Escreva números de um jeito fácil de ler em voz alta.
2. Ao citar uma peça do modelo 3D que está no projetor, escreva o nome dela entre colchetes, igual ao do modelo, por exemplo: "o [Núcleo] fica no centro". A peça acende no holograma enquanto você fala. Só use colchetes para peças que existem.
3. Depois da fala, numa linha separada, escreva ### seguido de um objeto JSON com os comandos. Sem comandos, escreva ### {}

COMANDOS (todos opcionais, no JSON depois de ###)
- "cena": "nova" (troca o que está no projetor), "adicionar" (coloca ao lado para comparar; máximo 3) ou "limpar" (apaga tudo). Com "nova" ou "adicionar", envie "modelo", "pronto" ou "busca".
- "modelo": {"nome": "...", "partes": [...]}
- "pronto": nome de um modelo anatômico real e detalhado (veja ANATOMIA). Use no lugar de "modelo".
- "busca": {"termo": "o que procurar, em inglês", "nome": "nome em português"}: baixa da internet um modelo 3D detalhado feito por artistas (veja MODELOS DA INTERNET).
- "acao": "explodir" (separa as peças em vista explodida, como o Tony faz), "montar" (junta de novo), "girar" ou "parar_giro".
- "musica": {"acao": "tocar", "faixa": "nome"}, ou {"acao": "parar" | "pausar" | "continuar" | "proxima" | "anterior"}, ou {"acao": "volume", "valor": 0 a 100}
- "timer": {"segundos": N, "nome": "para que é"} ou {"cancelar": "nome"} (use "" para cancelar todos)
- "lembrar": "fato curto sobre o usuário" (quando ele pedir para lembrar algo ou contar algo importante sobre si)
- "esquecer": "trecho do fato"

PROJETOR 3D
Sempre que o assunto puder ser visto (objetos, máquinas, veículos, planetas, átomos, moléculas, animais, construções, geometria, física...), mostre um modelo no projetor, mesmo sem o usuário pedir: anatomia humana com "pronto" (veja ANATOMIA), coisas reais e concretas com "busca" quando ela estiver ligada (veja MODELOS DA INTERNET), e o resto você monta com formas básicas, de um jeito SIMPLIFICADO. Em papo casual, sem nada visual, não gere modelo. O usuário pega, gira e separa o modelo com as mãos: capriche nas proporções, nas cores e nos nomes das peças.
Parte: {"nome": "...", "forma": "...", "tam": [largura, altura, profundidade], "pos": [x, y, z], "rot": [graus_x, graus_y, graus_z], "cor": "#rrggbb", "material": "...", "giro": 0, "orbita": 0}
- Omita "rot", "material", "giro" e "orbita" quando forem o padrão ([0,0,0], "plastico", 0, 0), para responder mais rápido.
- formas: ${SHAPES.join(', ')}. Cilindro aceita "topo" (0 a 1: raio do topo em relação à base, para troncos de cone). Tubo aceita "espessura" (0 a 1).
- "tam" é o tamanho total da peça em cada eixo. Cilindro, cone, pirâmide, prisma, tubo e cápsula ficam em pé no eixo y. Toro fica deitado no plano xz: largura e profundidade = diâmetro externo, altura = espessura do anel.
- materiais: plastico (padrão), fosco, metal, vidro (transparente) e luz (emite luz: Sol, lâmpadas, fogo, telas, motores).
- y é para cima. Centre o modelo na origem, entre -5 e 5 em cada eixo; ele é redimensionado sozinho.
- "giro": voltas por segundo no próprio eixo y (hélice 0.5, planeta 0.1). "orbita": voltas por segundo ao redor do eixo y da origem (planetas, elétrons); a peça precisa estar afastada da origem.
- Use de 4 a 30 peças. Para alterar o modelo atual (cor, peça nova, tamanho), devolva o modelo completo com "cena": "nova".
- No histórico, modelos antigos aparecem resumidos como texto; nas suas respostas, "modelo" é sempre o objeto completo.

ANATOMIA
Para o corpo humano NUNCA monte com formas básicas: use "pronto", que carrega modelos 3D reais e detalhados (atlas BodyParts3D). Cite as peças entre colchetes com estes nomes (plural acende todas: [Pulmões], [Costelas]):
- "coracao" (coração): Ventrículo esquerdo, Ventrículo direito, Átrio esquerdo, Átrio direito, Valva mitral, Valva tricúspide, Valva aórtica, Valva pulmonar, Artérias coronárias, Veias cardíacas, Aorta, Tronco pulmonar, Veias cavas, Veias pulmonares.
- "cerebro" (cérebro): Lobo frontal, Lobo parietal, Lobo temporal, Lobo occipital, Ínsula, Giro do cíngulo, Substância branca, Corpo caloso, Fórnix e comissuras, Tálamo, Hipotálamo, Hipocampo, Amígdala, Núcleos da base, Mesencéfalo, Ponte, Bulbo, Cerebelo, Vias ópticas, Hipófise, Glândula pineal, Ventrículos cerebrais.
- "esqueleto": Crânio, Mandíbula, Dentes, Osso hioide, Vértebras cervicais, Vértebras torácicas, Vértebras lombares, Sacro, Discos intervertebrais, Esterno, Costelas, Cartilagens costais, Clavículas, Escápulas, Úmeros, Rádios, Ulnas, Ossos do carpo, Metacarpos, Falanges das mãos, Pelve, Fêmures, Patelas, Tíbias, Fíbulas, Ossos do tarso, Metatarsos, Falanges dos pés.
- "respiratorio" (sistema respiratório, pulmões): Lobo superior do pulmão direito, Lobo médio do pulmão direito, Lobo inferior do pulmão direito, Lobo superior do pulmão esquerdo, Lobo inferior do pulmão esquerdo, Traqueia e brônquios, Laringe, Diafragma.
- "orgaos" (órgãos do tronco, sistema digestório, rins): os lobos dos pulmões, Traqueia e brônquios, Coração, Aorta, Veias cavas, Tronco pulmonar, Timo, Esôfago, Fígado, Vesícula biliar, Estômago, Baço, Pâncreas, Duodeno, Intestino delgado, Intestino grosso, Apêndice, Rins, Glândulas suprarrenais, Ureteres, Bexiga, Coluna vertebral.
- "corpo_humano" (corpo inteiro): Pele, Cérebro, Olhos, Crânio, Coluna vertebral, Caixa torácica, Ossos dos braços, Ossos das mãos, Pelve, Ossos das pernas, Ossos dos pés e os órgãos do tronco.
Exemplo: ### {"cena":"nova","pronto":"coracao"}

MODELOS DA INTERNET
Só quando o contexto disser que a busca do Sketchfab está ligada. Para coisas reais e concretas que ficam muito melhores com detalhe (carros, motos, aviões, naves, robôs, armaduras, personagens, animais, dinossauros, prédios, monumentos, instrumentos, objetos), use "busca" em vez de montar: "termo" com 1 a 4 palavras em inglês (por exemplo "iron man armor", "tyrannosaurus rex", "eiffel tower") e "nome" em português. Junto, mande um "modelo" simples de 3 a 8 peças como reserva: ele só aparece se a busca falhar. O que você explica peça por peça (átomos, moléculas, sistema solar, geometria, física, circuitos) continua montado com formas básicas, e anatomia humana continua com "pronto". Na fala, diga só que está trazendo o modelo; o autor e a licença já aparecem na tela. Um modelo baixado tem peças com nomes próprios: só cite entre colchetes os nomes que aparecem no Projetor, no contexto.
Exemplo: ### {"cena":"nova","busca":{"termo":"iron man armor","nome":"Armadura do Homem de Ferro"},"modelo":{"nome":"Armadura do Homem de Ferro","partes":[{"nome":"Tronco","forma":"capsula","tam":[1,1.4,0.6],"pos":[0,1.6,0],"cor":"#b3121a","material":"metal"},{"nome":"Reator arc","forma":"cilindro","tam":[0.3,0.06,0.3],"pos":[0,1.8,0.31],"rot":[90,0,0],"cor":"#9fe8ff","material":"luz"},{"nome":"Capacete","forma":"esfera","tam":[0.55,0.65,0.6],"pos":[0,2.65,0],"cor":"#d4a017","material":"metal"}]}}

MÚSICA
Você toca, pelo YouTube oficial, a trilha do Tony Stark: ${trackList()}. Fora dessa lista, diga com elegância que por enquanto só tem essas. Ao tocar, fale pouco.

PROTOCOLOS (referências aos filmes)
- "Protocolo festa em casa": toque Shoot To Thrill e anuncie o protocolo como no filme.
- "Protocolo casa limpa": limpe o projetor e pare a música.

LIMITES
Você não acessa e-mails, arquivos nem outros aplicativos. Da internet, você só baixa modelos 3D do Sketchfab (quando a busca está ligada); não pesquisa notícias, preços nem outros dados. Não invente dados em tempo real: use só o contexto que vem antes da mensagem do usuário. Se não souber, diga.

EXEMPLO
Claro, senhor. Um átomo de hélio: o [Núcleo] tem dois prótons e dois nêutrons, e os [Elétrons] orbitam ao redor.
### {"cena":"nova","modelo":{"nome":"Átomo de hélio","partes":[{"nome":"Núcleo","forma":"esfera","tam":[1,1,1],"pos":[0,0,0],"cor":"#e4572e","giro":0.1},{"nome":"Elétron 1","forma":"esfera","tam":[0.3,0.3,0.3],"pos":[2.5,0,0],"cor":"#5cd0ff","material":"luz","orbita":0.4},{"nome":"Elétron 2","forma":"esfera","tam":[0.3,0.3,0.3],"pos":[-2.5,0,0],"cor":"#5cd0ff","material":"luz","orbita":0.4},{"nome":"Órbita","forma":"toro","tam":[5,0.04,5],"pos":[0,0,0],"cor":"#8aa0b8","material":"fosco"}]}}`;

function contextMessage(ctx) {
  return `[Contexto atual, não responda a isto]
- Você chama o usuário de: ${ctx.name || 'senhor'}
- Agora: ${ctx.now}
- ${ctx.weather}
- Projetor: ${ctx.scene || 'vazio'}
- Busca de modelos 3D na internet (Sketchfab): ${ctx.sketchfab ? 'ligada' : 'desligada (para ligar, o usuário cola o token do Sketchfab nas configurações)'}
- Música: ${ctx.music || 'nenhuma tocando'}
- Timers ativos: ${ctx.timers || 'nenhum'}
- O que você lembra sobre o usuário:
${ctx.memory}`;
}

// ---------- Leitura do streaming ----------
async function* streamContent(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const j = JSON.parse(data);
        const piece = j.choices?.[0]?.delta?.content;
        if (piece) yield piece;
      } catch { /* linha incompleta */ }
    }
  }
}

// Quebra o texto em frases conforme ele chega; frases muito curtas esperam a próxima
export class Splitter {
  constructor(onSentence) {
    this.buf = '';
    this.pending = '';
    this.onSentence = onSentence;
  }

  push(text) {
    this.buf += text;
    const re = /^[\s\S]*?(?:[.!?…]+["'”»)\]]*(?=\s)|\n)/;
    let m;
    while ((m = this.buf.match(re))) {
      this.buf = this.buf.slice(m[0].length);
      this._add(m[0]);
    }
  }

  _add(s) {
    const t = s.replace(/\s+/g, ' ').trim();
    if (!t) return;
    this.pending = this.pending ? `${this.pending} ${t}` : t;
    if (this.pending.replace(/\[|\]/g, '').length >= 22) {
      this.onSentence(this.pending);
      this.pending = '';
    }
  }

  flush() {
    const rest = `${this.pending} ${this.buf}`.replace(/\s+/g, ' ').trim();
    this.buf = '';
    this.pending = '';
    if (rest) this.onSentence(rest);
  }
}

export class Brain {
  constructor() {
    this.history = [];
  }

  reset() {
    this.history = [];
  }

  // Responde em streaming. onSentence(frase) é chamado para cada frase falada, assim que ela fica pronta.
  async reply({ key, models, text, ctx, signal, onSentence, onRetry }) {
    const messages = [
      { role: 'system', content: SYSTEM },
      ...this.history,
      { role: 'user', content: contextMessage(ctx) },
      { role: 'user', content: text },
    ];
    let lastErr = null;
    for (const model of models) {
      try {
        const out = await this._run(key, model, messages, signal, onSentence);
        this._remember(text, out);
        return { ...out, model };
      } catch (e) {
        lastErr = e;
        // limite de uso ou modelo indisponível: tenta o próximo, se ainda não falou nada
        if (e.spoke || e.name === 'AbortError' || !(e.status === 429 || e.status === 413 || e.status === 404 || e.status === 503 || e.status === 400)) break;
        onRetry?.(model, e);
      }
    }
    throw lastErr;
  }

  async _run(key, model, messages, signal, onSentence) {
    const body = {
      model,
      messages,
      temperature: 0.6,
      max_completion_tokens: 2400,
      stream: true,
    };
    if (model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';
    const res = await call(key, '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    let raw = '';
    let fed = 0;
    let mode = null; // 'speech' (texto e depois ###) ou 'json' (modelo respondeu só JSON)
    let closed = false;
    let spoke = false;
    const splitter = new Splitter((s) => { spoke = true; onSentence(s); });
    try {
      for await (const piece of streamContent(res)) {
        raw += piece;
        if (!mode) {
          const t = raw.trimStart();
          if (!t) continue;
          mode = t[0] === '{' || t.startsWith('```') ? 'json' : 'speech';
        }
        if (mode !== 'speech' || closed) continue;
        const idx = raw.indexOf('###');
        // não envia para a voz os "#" que podem ser o começo do separador
        const limit = idx >= 0 ? idx : raw.length - (raw.match(/#{1,2}$/)?.[0].length || 0);
        if (limit > fed) {
          splitter.push(raw.slice(fed, limit));
          fed = limit;
        }
        if (idx >= 0) {
          splitter.flush();
          closed = true;
        }
      }
    } catch (e) {
      e.spoke = spoke;
      throw e;
    }

    let speech = '';
    let cmdText = '';
    if (mode === 'json') {
      const data = parseJson(raw);
      speech = cleanSpaces(String(data?.fala || ''));
      cmdText = raw;
      const sp = new Splitter(onSentence);
      sp.push(speech + ' ');
      sp.flush();
      return { speech, cmd: sanitizeCommands(data || {}) };
    }
    const idx = raw.indexOf('###');
    speech = cleanSpaces(idx >= 0 ? raw.slice(0, idx) : raw);
    cmdText = idx >= 0 ? raw.slice(idx + 3) : '';
    if (!closed) splitter.flush();
    return { speech, cmd: sanitizeCommands(parseJson(cmdText) || {}) };
  }

  _remember(text, out) {
    this.history.push({ role: 'user', content: text });
    // no histórico o modelo 3D vira um resumo, para economizar tokens
    const c = { ...out.cmd };
    if (c.modelo) c.modelo = c.busca ? '(modelo simples de reserva)' : `(modelo "${c.modelo.nome}" com ${c.modelo.partes.length} peças, já mostrado)`;
    for (const k of Object.keys(c)) if (c[k] == null) delete c[k];
    this.history.push({ role: 'assistant', content: `${out.speech}\n### ${JSON.stringify(c)}` });
    if (this.history.length > 12) this.history.splice(0, this.history.length - 12);
  }
}

const cleanSpaces = (t) => t.replace(/\s+/g, ' ').trim();

export function parseJson(text) {
  if (!text) return null;
  let t = text.replace(/```(?:json)?/gi, '').trim();
  const start = t.indexOf('{');
  if (start < 0) return null;
  // pega o primeiro objeto completo (conta chaves, respeitando strings)
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { end = i; break; }
  }
  t = end > 0 ? t.slice(start, end + 1) : t.slice(start);
  try { return JSON.parse(t); } catch { /* tenta consertar */ }
  try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const vec = (v, d) => (Array.isArray(v) ? [0, 1, 2].map((i) => num(v[i], d[i])) : d);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// outros jeitos de o modelo de linguagem pedir os modelos de anatomia
const PREFAB_ALIASES = {
  pulmao: 'respiratorio', pulmoes: 'respiratorio', sistema_respiratorio: 'respiratorio',
  corpo: 'corpo_humano', corpo_inteiro: 'corpo_humano',
  orgaos_do_tronco: 'orgaos', sistema_digestorio: 'orgaos', digestorio: 'orgaos',
  coracao_humano: 'coracao', cerebro_humano: 'cerebro', esqueleto_humano: 'esqueleto', ossos: 'esqueleto',
};

export function sanitizeCommands(d) {
  const out = { cena: null, modelo: null, pronto: null, busca: null, acao: null, musica: null, timer: null, lembrar: null, esquecer: null };
  const modelo = sanitizeModel(d.modelo);
  // modelo pronto de anatomia ("corpo humano", "Coração"...) e busca de modelo na internet
  let pronto = norm(d.pronto).replace(/[\s-]+/g, '_');
  pronto = PREFAB_ALIASES[pronto] || pronto;
  const busca = sanitizeSearch(d.busca);
  const has = modelo || PREFAB_NAMES.includes(pronto) || busca;
  const cena = ['nova', 'adicionar', 'limpar'].includes(norm(d.cena)) ? norm(d.cena) : (has ? 'nova' : null);
  if (cena === 'limpar') out.cena = 'limpar';
  else if (PREFAB_NAMES.includes(pronto)) { out.cena = cena; out.pronto = pronto; }
  else if (busca) { out.cena = cena; out.busca = busca; out.modelo = modelo; }
  else if (modelo) { out.cena = cena; out.modelo = modelo; }
  const acao = norm(d.acao).replace(' ', '_');
  if (['explodir', 'montar', 'girar', 'parar_giro'].includes(acao)) out.acao = acao;
  if (d.musica && typeof d.musica === 'object') out.musica = { acao: norm(d.musica.acao), faixa: String(d.musica.faixa || ''), valor: d.musica.valor };
  if (d.timer && typeof d.timer === 'object') {
    if (d.timer.cancelar !== undefined) out.timer = { cancelar: String(d.timer.cancelar || '') };
    else if (num(d.timer.segundos) > 0) out.timer = { segundos: num(d.timer.segundos), nome: String(d.timer.nome || 'Timer') };
  }
  if (typeof d.lembrar === 'string' && d.lembrar.trim()) out.lembrar = d.lembrar.trim();
  if (typeof d.esquecer === 'string' && d.esquecer.trim()) out.esquecer = d.esquecer.trim();
  return out;
}

// {"termo": "palavras em inglês", "nome": "nome em português"}
function sanitizeSearch(b) {
  if (!b) return null;
  const termo = String(typeof b === 'string' ? b : b.termo || b.nome || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (termo.length < 2) return null;
  const nome = String((typeof b === 'object' && b.nome) || termo).replace(/\s+/g, ' ').trim().slice(0, 50);
  return { termo, nome };
}

// Listas de números vindas da IA: só as bem formadas, com limites
const coord = (v) => Math.min(20, Math.max(-20, num(v)));
const radius = (v, d) => Math.min(10, Math.max(0.004, Math.abs(num(v, d))));
function rows(list, max, min, len, fix) {
  if (!Array.isArray(list)) return [];
  return list.filter((r) => Array.isArray(r) && r.length >= min && r.slice(0, len).every((v) => Number.isFinite(+v))).slice(0, max).map(fix);
}

// Formas livres: confere os dados de cada uma e, se faltar o essencial, cai numa forma simples
function freeform(p, forma) {
  const out = {};
  if (forma === 'organico') {
    out.bolas = rows(p.bolas, 48, 4, 6, (r) => (r.length >= 6
      ? [coord(r[0]), coord(r[1]), coord(r[2]), radius(r[3]), radius(r[4]), radius(r[5])]
      : [coord(r[0]), coord(r[1]), coord(r[2]), radius(r[3])]));
    out.bastoes = rows(p.bastoes, 48, 7, 8, (r) => [coord(r[0]), coord(r[1]), coord(r[2]), coord(r[3]), coord(r[4]), coord(r[5]), radius(r[6]), radius(r[7] ?? r[6])]);
    if (!out.bolas.length && !out.bastoes.length) return null;
    if (p.suave !== undefined) out.suave = Math.max(0.02, Math.min(1.2, num(p.suave, 0.35)));
  } else if (forma === 'curva') {
    out.pontos = rows(p.pontos, 48, 3, 3, (r) => [coord(r[0]), coord(r[1]), coord(r[2])]);
    if (out.pontos.length < 2) return null;
    out.raio = radius(p.raio, 0.1);
    out.raio_fim = p.raio_fim !== undefined ? radius(p.raio_fim, out.raio) : out.raio;
  } else if (forma === 'torno') {
    out.perfil = rows(p.perfil, 48, 2, 2, (r) => [Math.min(10, Math.max(0, num(r[0]))), coord(r[1])]);
    if (out.perfil.length < 2) return null;
  } else if (forma === 'extrusao') {
    out.contorno = rows(p.contorno, 96, 2, 2, (r) => [coord(r[0]), coord(r[1])]);
    if (out.contorno.length < 3) return null;
    out.profundidade = radius(p.profundidade, 0.2);
  } else if (forma === 'engrenagem') {
    out.dentes = Math.max(5, Math.min(80, Math.round(num(p.dentes, 16))));
    out.furo = Math.max(0, Math.min(0.8, num(p.furo, 0.25)));
  } else if (forma === 'mola') {
    out.voltas = Math.max(1, Math.min(30, num(p.voltas, 6)));
    if (p.fio !== undefined) out.fio = radius(p.fio, 0.1);
  }
  return out;
}

const FALLBACK = { organico: 'esfera', curva: 'cilindro', torno: 'cilindro', extrusao: 'caixa' };

export function sanitizeModel(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.partes)) return null;
  const partes = m.partes.slice(0, 60).filter((p) => p && typeof p === 'object').map((p, i) => {
    let material = norm(p.material);
    if (!MATERIALS.includes(material)) material = p.brilho ? 'luz' : 'plastico';
    let forma = SHAPES.includes(norm(p.forma)) ? norm(p.forma) : 'caixa';
    let extra = freeform(p, forma);
    if (!extra) { forma = FALLBACK[forma]; extra = {}; }
    return {
      ...extra,
      nome: String(p.nome || `Peça ${i + 1}`).slice(0, 40),
      forma,
      tam: vec(p.tam, [1, 1, 1]).map((v) => Math.min(20, Math.max(0.02, Math.abs(v)))),
      pos: vec(p.pos, [0, 0, 0]).map((v) => Math.min(20, Math.max(-20, v))),
      rot: vec(p.rot, [0, 0, 0]),
      cor: /^#[0-9a-f]{6}$/i.test(p.cor) ? p.cor : /^#[0-9a-f]{3}$/i.test(p.cor) ? '#' + p.cor.slice(1).split('').map((c) => c + c).join('') : '#9aa4b2',
      material,
      topo: p.topo !== undefined ? Math.max(0, Math.min(1, num(p.topo, 1))) : undefined,
      espessura: p.espessura !== undefined ? Math.max(0.05, Math.min(0.95, num(p.espessura, 0.25))) : undefined,
      giro: Math.max(-3, Math.min(3, num(p.giro))),
      orbita: Math.max(-2, Math.min(2, num(p.orbita))),
    };
  });
  if (!partes.length) return null;
  return { nome: String(m.nome || 'Modelo').slice(0, 50), partes };
}

// Texto que vai para a voz: sem colchetes, markdown, emojis ou links
export function cleanSpeech(t) {
  return t
    .replace(/\[([^\]]*)\]/g, '$1')
    .replace(/[*_#`>|~]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Nomes de peças citados entre colchetes numa frase
export function bracketNames(t) {
  return [...t.matchAll(/\[([^\]]{1,40})\]/g)].map((m) => m[1]);
}
