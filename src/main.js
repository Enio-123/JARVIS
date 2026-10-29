import * as THREE from 'three';
import { canvas, renderer, scene, camera, resize, updateCamera, raycast, pointAt, toScreen, depthOf, platform, portrait, setLift, liftFor } from './stage.js';
import * as hands from './hands.js';
import { GrabSystem } from './grab.js';
import { Projector } from './projector.js';
import { Brain, pickModels, transcribe, cleanSpeech, bracketNames, GroqError, sanitizeCommands } from './brain.js';
import { buildPrefab } from './anatomy.js';
import { Ear } from './ear.js';
import { Voice, ENGINE_LABELS, PIPER_CACHE, elevenVoices, sentences } from './voice.js';
import { Character } from './character.js';
import { Sfx } from './sfx.js';
import { Music } from './music.js';
import { World, nowText, greetingWord, spokenTime } from './world.js';
import { Timers, fmt } from './timers.js';
import { memory } from './memory.js';
import { settings, save, wipe } from './settings.js';

const $ = (id) => document.getElementById(id);
const debug = new URLSearchParams(location.search).has('debug');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const narrow = matchMedia('(max-width: 700px)');

// ---------- Estado da conversa ----------
// off | booting | listening | hearing | thinking | speaking | paused
let state = 'off';
let models = null; // { chat: [...], stt } escolhidos para a chave
let audioCtx = null;
let ear = null;
let voice = null;
let sfx = null;
let micPaused = false;
let lastReplyAt = 0;
let lastErrorSpoken = 0;
let busy = false;
let turn = 0; // cada fala nova invalida a anterior
let abort = null;
const brain = new Brain();
const projector = new Projector();
const jarvis = new Character();
const music = new Music();
const world = new World();
const timers = new Timers(onTimer, renderTimers);
const announcements = [];

const FOLLOW_UP_MS = 12000; // depois de uma resposta, dá para continuar sem dizer "Jarvis"
const FLING_PX = 1500; // velocidade da mão/mouse (pixels por segundo) que conta como "jogar fora"
const WAKE = /\b(j[aáe]rv[iíe][sz]|jarvas|javis|jarbas|djarvis)\b/i;
// Depois de "Jarvis", estas palavras só pedem para ele parar (não viram pergunta)
const STOP = /^(para|pare|parar|pera|espera|chega|basta|sil[eê]ncio|cala|quiet[oa]|ok|okay|obrigad[oa]|valeu|beleza|tudo bem|j[aá] (deu|chega|entendi|sei)|pode parar|entendi|t[aá] bom)\b/i;
// Sem o nome no prompt: o Whisper às vezes "repete" o prompt em ruído, o que daria falsos "Jarvis"
const BARGE_PROMPT = 'Comando de voz em português.';

const STATUS = {
  off: ['', 'Desligado'],
  booting: ['busy', 'Iniciando'],
  listening: ['listen', 'Ouvindo'],
  hearing: ['listen', 'Ouvindo você'],
  thinking: ['busy', 'Pensando'],
  speaking: ['speak', 'Falando'],
  paused: ['', 'Microfone pausado'],
};

const who = () => settings.name?.trim() || 'senhor';
const Who = () => who()[0].toUpperCase() + who().slice(1); // no começo da frase
const wakeRequired = () => music.playing || (settings.wake && performance.now() - lastReplyAt > FOLLOW_UP_MS);

function setState(s) {
  state = s;
  const [cls, text] = STATUS[s];
  $('dot').className = 'dot ' + cls;
  $('status').textContent = s === 'listening' && (music.playing || settings.wake) ? 'Diga “Jarvis”' : text;
  document.body.dataset.state = s;
  // enquanto ele pensa ou fala, o microfone continua ligado só para ouvir alguém chamando "Jarvis"
  const jt = s === 'thinking' || s === 'speaking';
  ear?.setEnabled(s === 'listening' || s === 'hearing' || (jt && !micPaused));
  ear?.setBarge(jt);
  if (!jt) unbarge();
}

const jarvisTurn = () => state === 'thinking' || state === 'speaking';

function idle() {
  setState(micPaused ? 'paused' : 'listening');
  setTimeout(nextAnnouncement, 400);
}

// ---------- Legendas ----------
const cap = { words: [], total: 0, shown: 0, fadeTimer: 0 };

function wakeCaptions() {
  clearTimeout(cap.fadeTimer);
  $('capYou').classList.remove('fade');
  $('capHim').classList.remove('fade');
}

function showYou(text) {
  wakeCaptions();
  const b = document.createElement('b');
  b.textContent = 'VOCÊ';
  $('capYou').replaceChildren(b, document.createTextNode(text));
  $('capHim').replaceChildren();
  cap.words = [];
}

// A fala do JARVIS aparece palavra por palavra, no ritmo da voz; peças citadas ficam em azul
function showHim(raw) {
  wakeCaptions();
  const nodes = [];
  cap.words = [];
  let total = 0;
  for (const seg of raw.split(/(\[[^\]]*\])/)) {
    const isPart = seg.startsWith('[') && seg.endsWith(']');
    for (const w of cleanSpeech(isPart ? seg.slice(1, -1) : seg).split(/\s+/).filter(Boolean)) {
      const span = document.createElement('span');
      span.textContent = w;
      if (isPart) span.className = 'part';
      total += w.length + 1;
      cap.words.push({ span, end: total });
      nodes.push(span, document.createTextNode(' '));
    }
  }
  cap.total = total;
  cap.shown = 0;
  $('capHim').replaceChildren(...nodes);
}

function updateCaption() {
  if (!cap.words.length || !voice?.now) return;
  const reach = voice.progress() * cap.total + 3;
  let n = cap.shown;
  while (n < cap.words.length && cap.words[n].end <= reach) cap.words[n++].span.classList.add('said');
  cap.shown = n;
}

function finishCaption() {
  for (const w of cap.words) w.span.classList.add('said');
  cap.shown = cap.words.length;
  clearTimeout(cap.fadeTimer);
  cap.fadeTimer = setTimeout(() => {
    $('capYou').classList.add('fade');
    $('capHim').classList.add('fade');
  }, 10000);
}

let noteTimer = 0;
function note(text, ms = 0, err = false) {
  clearTimeout(noteTimer);
  const el = $('capNote');
  el.textContent = text || '';
  el.classList.toggle('err', !!err && !!text);
  if (ms && text) noteTimer = setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, ms);
}

// ---------- Fala ----------
let turnSpoken = []; // frases já faladas nesta resposta
function beginSpeech(myTurn) {
  turnSpoken = [];
  return voice.begin(settings, {
    onStart: (i, it) => {
      if (myTurn !== turn) return;
      setState('speaking');
      turnSpoken.push(it.text);
      const raw = it.meta?.raw ?? it.text;
      showHim(raw);
      projector.setHighlight(bracketNames(raw));
    },
  });
}

async function finishTurn(myTurn) {
  if (myTurn !== turn) return;
  music.duck('jarvis', false);
  projector.setHighlight([]);
  finishCaption();
  lastReplyAt = performance.now();
  await sleep(250); // o eco da própria voz não pode virar pergunta
  if (myTurn === turn && (state === 'speaking' || state === 'thinking')) idle();
}

// Fala um texto pronto (saudação, avisos, erros)
async function say(text) {
  if (!voice || !text) return;
  const myTurn = ++turn;
  music.duck('jarvis', true);
  const sp = beginSpeech(myTurn);
  for (const s of sentences(text)) sp.push(cleanSpeech(s), { raw: s });
  sp.end();
  await sp.done;
  await finishTurn(myTurn);
}

function announce(text) {
  announcements.push(text);
  nextAnnouncement();
}

function nextAnnouncement() {
  if (!announcements.length || busy || !voice) return;
  if (state !== 'listening' && state !== 'paused') return;
  say(announcements.shift());
}

function interrupt() {
  if (state === 'speaking' || state === 'thinking') {
    turn++;
    abort?.abort();
    voice?.stop();
    music.duck('jarvis', false);
    music.duck('user', false);
    projector.setHighlight([]);
    finishCaption();
    lastReplyAt = performance.now(); // logo depois dá para pedir outra coisa sem repetir "Jarvis"
    idle();
  } else if (state === 'paused') {
    toggleMic();
  }
}

// ---------- Ciclo: ouvir -> transcrever -> pensar e falar ao mesmo tempo ----------
// As falas captadas entram numa fila curta (só a transcrição espera; a resposta corre em paralelo),
// assim um "Jarvis" dito durante a resposta é ouvido na hora.
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((e) => console.warn(e));
}

function routeUtterance(wav) {
  if (bargeWoke) { bargeWoke = false; return heardAfterWake(wav); }
  if (jarvisTurn()) return bargeCheck(wav, false);
  return onUtterance(wav);
}

async function onUtterance(wav) {
  if (!models) return;
  busy = true;
  const myTurn = turn;
  const needWake = wakeRequired();
  setState('thinking');
  let text = '';
  try {
    text = await transcribe(settings.groqKey, models.stt, wav);
  } catch (e) {
    music.duck('user', false);
    if (e.name !== 'AbortError' && myTurn === turn) failSpeak(e);
    else if (myTurn === turn) idle();
    return;
  } finally {
    busy = false;
  }
  if (myTurn !== turn) return;
  music.duck('user', false);
  if (!text || (needWake && !WAKE.test(text))) {
    idle();
    return;
  }
  sfx?.ack();
  respond(text);
}

// ---------- Chamar "Jarvis" enquanto ele fala ----------
// Quando alguém começa a falar por cima, a voz dele abaixa na hora. Se a fala tiver "Jarvis",
// ele para de falar (a prévia do começo da fala já basta para isso); se não tiver, a voz volta.
let bargeWoke = false; // o "Jarvis" já parou a fala; o resto do que a pessoa disser vira o pedido
let bargeOpen = false;

function unbarge() {
  if (!bargeOpen) return;
  bargeOpen = false;
  voice?.duck(false);
  music.duck('user', false);
  document.body.classList.remove('barge');
}

// O que vem depois do nome ("Jarvis, me mostra um carro" -> "me mostra um carro")
function afterWake(text) {
  const m = text.match(WAKE);
  if (!m) return text.trim();
  return text.slice(m.index + m[0].length).replace(/^[\s,.!?:;…-]+/, '').trim();
}

// O trecho é só a voz do próprio JARVIS voltando pelo microfone?
function isEcho(text) {
  const said = new Set(normalizeWords(turnSpoken.join(' ')));
  const words = normalizeWords(text).filter((w) => w.length > 2);
  if (!words.length) return false;
  return words.filter((w) => said.has(w)).length / words.length >= 0.6;
}
const normalizeWords = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

async function bargeCheck(wav, early) {
  if (!models) return;
  const myTurn = turn;
  let text = '';
  try {
    text = await transcribe(settings.groqKey, models.stt, wav, BARGE_PROMPT);
  } catch {
    if (!early) unbarge();
    return;
  }
  if (myTurn !== turn || !jarvisTurn()) {
    if (!early) unbarge();
    return;
  }
  // ele mesmo disse o próprio nome nesta resposta: não conta
  const selfNamed = turnSpoken.slice(-2).some((t) => WAKE.test(t));
  if (!WAKE.test(text) || selfNamed) {
    if (!early) {
      unbarge();
      // foi só eco ou conversa paralela: exige um pouco mais de volume da próxima vez
      if (ear) ear.bargeBoost = Math.min(2.5, ear.bargeBoost + 0.25);
    }
    return;
  }
  // ouviu o nome: para de falar na hora
  if (ear) ear.bargeBoost = 1;
  interrupt();
  sfx?.chirp();
  if (early) {
    // a pessoa ainda está falando: o pedido completo chega quando ela terminar
    bargeWoke = true;
    if (ear?.speaking && state === 'listening') {
      setState('hearing');
      if (music.playing) music.duck('user', true);
    }
    return;
  }
  const rest = afterWake(text);
  if (!rest || STOP.test(rest) || isEcho(rest)) return;
  showYou(rest);
  respond(rest);
}

// Fala completa de quem interrompeu com "Jarvis" (a voz dele já parou)
async function heardAfterWake(wav) {
  if (!models) return;
  const myTurn = turn;
  setState('thinking');
  let text = '';
  try {
    text = await transcribe(settings.groqKey, models.stt, wav, BARGE_PROMPT);
  } catch {
    if (myTurn === turn) idle();
    return;
  }
  if (myTurn !== turn) return;
  const rest = afterWake(text);
  if (!rest || STOP.test(rest) || isEcho(rest)) { idle(); return; }
  sfx?.ack();
  respond(rest);
}

function context() {
  const t = music.track;
  return {
    name: who(),
    now: nowText(),
    weather: settings.weather ? world.describe() : 'O usuário desativou o clima.',
    scene: projector.describe(),
    music: t ? `${t.title}, ${t.artist} (${music.state === 'paused' ? 'pausada' : 'tocando'})` : '',
    timers: timers.describe(),
    memory: memory.describe(),
    sketchfab: !!settings.sketchfabKey,
  };
}

async function respond(text) {
  const myTurn = ++turn;
  abort?.abort();
  const ac = (abort = new AbortController());
  showYou(text);
  setState('thinking');
  music.duck('jarvis', true);
  const sp = beginSpeech(myTurn);
  let out;
  try {
    out = await brain.reply({
      key: settings.groqKey,
      models: models.chat,
      text,
      ctx: context(),
      signal: ac.signal,
      onSentence: (raw) => { if (myTurn === turn) sp.push(cleanSpeech(raw), { raw }); },
      onRetry: () => note('Um modelo da Groq está no limite agora; usando outro.', 5000),
    });
  } catch (e) {
    sp.end();
    if (e.name === 'AbortError' || myTurn !== turn) return;
    await sp.done; // termina o que já tinha sido falado
    return failSpeak(e);
  }
  sp.end();
  if (myTurn !== turn) return;
  applyCommands(out.cmd);
  await sp.done;
  await finishTurn(myTurn);
}

async function failSpeak(e) {
  console.warn(e);
  const groq = e instanceof GroqError;
  note(groq ? e.message : `Algo deu errado: ${e.message || e}`, 9000, true);
  jarvis.error();
  sfx?.error();
  if (!voice || performance.now() - lastErrorSpoken < 15000) { idle(); return; }
  lastErrorSpoken = performance.now();
  const line = !groq ? `Desculpe, ${who()}. Tive um problema aqui. Pode repetir?`
    : e.status === 401 ? `${Who()}, a chave da Groq foi recusada. Confira nas configurações.`
    : e.status === 429 ? `Atingi o limite de uso da Groq por agora, ${who()}. Tente de novo em alguns segundos.`
    : e.status === 0 ? `Perdi a conexão com a Groq, ${who()}. Verifique a internet.`
    : `Desculpe, ${who()}. A Groq não respondeu direito. Pode repetir?`;
  await say(line);
}

// ---------- Comandos que vêm junto da resposta ----------
let loadSeq = 0; // cada pedido novo de cena cancela um modelo que ainda estava carregando
let searchAbort = null;

function applyCommands(c) {
  if (c.cena) {
    const my = ++loadSeq;
    projector.hideLoader();
    searchAbort?.abort();
    if (c.pronto) loadPrefab(c.pronto, c.cena, my);
    else if (c.busca) loadSearch(c.busca, c.cena, c.modelo, my);
    else shown(projector.apply(c.cena, c.modelo), c.cena);
  }
  if (c.acao === 'explodir') projector.explode(true);
  else if (c.acao === 'montar') projector.explode(false);
  else if (c.acao === 'girar') { projector.autoSpin = true; projector.lastTouch = 0; }
  else if (c.acao === 'parar_giro') projector.autoSpin = false;
  if (c.musica) {
    music.handle(c.musica).then(() => {
      if (c.musica.acao !== 'tocar' && c.musica.acao !== 'proxima' && c.musica.acao !== 'anterior') return;
      setTimeout(() => {
        if (music.state === 'loading') note('Se a música não começar sozinha, toque no play do vídeo.', 9000);
      }, 4500);
    }, (e) => note(e.message, 8000, true));
  }
  if (c.timer) {
    if (c.timer.cancelar !== undefined) timers.cancel(c.timer.cancelar);
    else timers.add(c.timer.segundos, c.timer.nome);
  }
  if (c.lembrar) memory.add(c.lembrar);
  if (c.esquecer) memory.forget(c.esquecer);
}

function shown(m, cena) {
  if (m) {
    sfx?.materialize();
    jarvis.present(m.position.clone());
    showHint();
  } else if (cena === 'limpar') {
    sfx?.dismiss();
  }
  updateHint();
}

// Modelos prontos de anatomia: montados aos poucos, com o holograma de "carregando" no lugar
async function loadPrefab(name, cena, my) {
  let modelo = null;
  try {
    modelo = await buildPrefab(name, (k, nome, fase) => { if (my === loadSeq) projector.showLoader(nome, `${fase} ${Math.round(k * 100)}%`); });
  } catch (e) {
    console.warn(e);
  }
  if (my !== loadSeq) return;
  projector.hideLoader();
  if (!modelo) { note('Não consegui montar esse modelo.', 6000, true); return; }
  shown(projector.apply(cena, modelo), cena);
}

// Modelos prontos da internet (Sketchfab), baixados com o token da pessoa. O módulo só carrega no
// primeiro uso. Se a busca falhar, entra o modelo simples de reserva que o JARVIS mandou junto.
const sketchfab = () => import('./sketchfab.js');
const SEARCH_PHASE = { Procurando: 'Procurando no Sketchfab', Abrindo: 'Abrindo o modelo' };

async function loadSearch(busca, cena, reserva, my) {
  const fallback = () => { if (reserva) shown(projector.apply(cena, reserva), cena); };
  if (!settings.sketchfabKey) {
    if (!reserva) note('Para buscar modelos na internet, cole o token do Sketchfab nas configurações.', 9000);
    fallback();
    return;
  }
  const ac = (searchAbort = new AbortController());
  let modelo = null;
  let erro = '';
  projector.showLoader(busca.nome, SEARCH_PHASE.Procurando);
  try {
    const sk = await sketchfab();
    try {
      modelo = await sk.findModel(busca, settings.sketchfabKey, (k, fase) => {
        if (my === loadSeq) projector.showLoader(busca.nome, SEARCH_PHASE[fase] || `${fase} ${Math.round(k * 100)}%`);
      }, ac.signal);
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn(e);
      erro = e instanceof sk.SketchfabError ? e.message : 'Não consegui abrir o modelo baixado.';
    }
  } catch (e) {
    console.warn(e);
    erro = 'Não consegui carregar a busca de modelos. Verifique a internet.';
  }
  if (my !== loadSeq) return;
  projector.hideLoader();
  if (modelo) { shown(projector.apply(cena, modelo), cena); return; }
  note(erro || `Não achei um modelo pronto de ${busca.nome} para baixar.`, 9000, !!erro);
  fallback();
}

// ---------- Timers ----------
const timerEls = new Map();
const X_ICON = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function renderTimers(tickOnly = false) {
  const box = $('timers');
  if (!tickOnly) {
    for (const [id, el] of timerEls) {
      if (!timers.items.some((t) => t.id === id)) { el.remove(); timerEls.delete(id); }
    }
    for (const t of timers.items) {
      if (timerEls.has(t.id)) continue;
      const el = document.createElement('div');
      el.className = 'timer';
      el.innerHTML = `<span class="tl"></span><span class="tt"></span><button title="Cancelar" aria-label="Cancelar timer">${X_ICON}</button><span class="tp"></span>`;
      el.querySelector('.tl').textContent = t.label;
      el.querySelector('button').addEventListener('click', () => timers.remove(t.id));
      box.append(el);
      timerEls.set(t.id, el);
    }
  }
  const now = Date.now();
  for (const t of timers.items) {
    const el = timerEls.get(t.id);
    if (!el) continue;
    el.querySelector('.tt').textContent = fmt(t.end - now);
    el.querySelector('.tp').style.width = `${Math.min(100, (1 - (t.end - now) / (t.total * 1000)) * 100)}%`;
  }
}

function onTimer(t) {
  sfx?.chime();
  jarvis.happy(2);
  const el = document.createElement('div');
  el.className = 'timer done';
  el.innerHTML = `<span class="tl"></span><span class="tt">00:00</span><button title="Ok" aria-label="Fechar aviso">${X_ICON}</button>`;
  el.querySelector('.tl').textContent = t.label;
  el.querySelector('button').addEventListener('click', () => el.remove());
  $('timers').append(el);
  setTimeout(() => el.remove(), 12000);
  announce(`${Who()}, o tempo acabou: ${t.label}.`);
}

// ---------- Música ----------
const PLAY_D = 'M8 5v14l11-7z';
const PAUSE_D = 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z';

music.onChange = () => {
  const t = music.track;
  $('mTitle').textContent = t ? t.title : '';
  $('mSub').textContent = t ? `${t.artist} · ${t.note}` : '';
  const paused = music.state === 'paused';
  $('mPlayIcon').setAttribute('d', paused ? PLAY_D : PAUSE_D);
  $('mPlay').title = paused ? 'Continuar' : 'Pausar';
  // com música, o microfone exige voz mais alta e frases curtas, e só responde a "Jarvis"
  if (ear) {
    ear.sensitivity = music.playing ? 1.6 : 1;
    ear.maxMs = music.playing ? 8000 : 25000;
  }
  if (state === 'listening') setState('listening');
};
music.onError = (track, msg) => { note(msg, 9000, true); sfx?.error(); };
$('mPrev').addEventListener('click', () => music.next(-1).catch((e) => note(e.message, 6000, true)));
$('mNext').addEventListener('click', () => music.next(1).catch((e) => note(e.message, 6000, true)));
$('mPlay').addEventListener('click', () => music.toggle());
$('mStop').addEventListener('click', () => music.stop());

// ---------- Relógio e clima ----------
function updateClock() {
  const d = new Date();
  $('clock').textContent = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const w = settings.weather && state !== 'off' ? world.weather : null;
  const el = $('weather');
  if (!w) { el.replaceChildren(); return; }
  const city = document.createElement('span');
  city.className = 'city';
  city.textContent = w.city ? `${w.city} · ` : '';
  const desc = document.createElement('span');
  desc.className = 'city';
  desc.textContent = w.desc ? ` · ${w.desc}` : '';
  el.replaceChildren(city, document.createTextNode(`${w.temp} °C`), desc);
}
setInterval(updateClock, 1000);
updateClock();
setInterval(() => {
  if (settings.weather && state !== 'off') world.refresh(true).then(updateClock);
}, 30 * 60 * 1000);

// ---------- Início ----------
const startKey = $('startKey');
$('startKeyField').hidden = !!settings.groqKey;
$('startCam').checked = settings.camera;
$('startWeather').checked = settings.weather;

const MIC_ERRORS = {
  NotAllowedError: 'A permissão do microfone foi negada. Libere o microfone para este site e tente de novo.',
  NotFoundError: 'Nenhum microfone foi encontrado.',
  NotReadableError: 'O microfone está sendo usado por outro programa.',
};

function unlockSpeech() {
  // destrava a voz do navegador dentro do clique (exigência do Chrome/Safari)
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

function wireEar() {
  ear.refLevel = () => (voice ? voice.outRms() : 0);
  ear.onUtterance = (wav) => enqueue(() => routeUtterance(wav));
  ear.onEarly = (wav) => {
    if (jarvisTurn() && !bargeWoke) enqueue(() => (bargeWoke ? null : bargeCheck(wav, true)));
  };
  ear.onSpeechStart = () => {
    if (jarvisTurn()) {
      // alguém falando por cima: abaixa a voz dele enquanto descobre se é com ele
      bargeOpen = true;
      voice?.duck(true);
      music.duck('user', true);
      document.body.classList.add('barge');
      return;
    }
    if (state !== 'listening') return;
    setState('hearing');
    if (music.playing) music.duck('user', true);
  };
  ear.onSpeechEnd = () => {
    unbarge();
    music.duck('user', false);
    if (state === 'hearing') idle();
  };
  music.onChange();
}

$('btnStart').addEventListener('click', async () => {
  const btn = $('btnStart');
  const result = $('startResult');
  const key = (startKey.value.trim() || settings.groqKey).trim();
  if (!key) {
    $('startKeyField').hidden = false;
    result.className = 'result err';
    result.textContent = 'Cole a chave da Groq para continuar.';
    startKey.focus();
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Conectando...';
  result.className = 'result';
  result.textContent = '';
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    unlockSpeech();
    voice ||= new Voice(audioCtx);
    voice.onNote = (t) => note(t, /não carregou|Usando a voz/.test(t) ? 12000 : 0);
    sfx ||= new Sfx(audioCtx);
    sfx.enabled = settings.sounds;
    const [picked] = await Promise.all([pickModels(key), voice.init()]);
    models = picked;
    save({ groqKey: key, camera: $('startCam').checked, weather: $('startWeather').checked });
    startKey.value = '';
    ear ||= new Ear(audioCtx);
    wireEar();
    if (!ear.active) {
      try {
        await ear.start();
      } catch (e) {
        throw new Error(MIC_ERRORS[e.name] || 'Não consegui ligar o microfone.');
      }
    }
    $('start').classList.remove('show');
    btn.blur();
    keepAwake();
    boot();
  } catch (e) {
    result.className = 'result err';
    result.textContent = e.message;
    $('startKeyField').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Iniciar';
  }
});
startKey.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnStart').click(); });

const ENGINE_SHORT = { piper: 'Piper Faber (neural)', eleven: 'ElevenLabs', microsoft: 'Microsoft neural', sistema: 'voz do sistema' };

// Sequência de inicialização: cada linha só aparece quando aquele sistema realmente respondeu
async function boot() {
  const t0 = performance.now();
  setState('booting');
  sfx.boot();
  jarvis.wake();
  const box = $('boot');
  const log = $('bootLog');
  log.replaceChildren();
  box.hidden = false;
  box.classList.remove('hide');
  const line = (k, v, s = 'ok') => {
    if (box.hidden) return;
    const li = document.createElement('li');
    li.innerHTML = '<span class="k"></span><span class="v"></span><span class="s"></span>';
    li.querySelector('.k').textContent = k;
    li.querySelector('.v').textContent = v;
    const st = li.querySelector('.s');
    st.textContent = s === 'ok' ? 'OK' : s === 'wait' ? 'AGUARDE' : 'OFF';
    st.className = 's ' + s;
    log.append(li);
  };
  line('Microfone', 'ativo');
  line('Transcrição', models.stt);
  line('Raciocínio', models.chat[0]);
  const engine = voice.resolve(settings);
  if (engine === 'piper' && !voice.piperCached) {
    voice.preparePiper();
    line('Voz', 'Piper Faber · baixando', 'wait');
  } else {
    line('Voz', ENGINE_SHORT[engine]);
  }
  if (settings.camera) {
    startCamera().then((ok) => line('Mãos', ok ? 'rastreamento ativo' : 'câmera indisponível', ok ? 'ok' : 'off'));
  } else {
    line('Mãos', 'câmera desligada', 'off');
  }
  if (settings.weather) {
    const w = await Promise.race([world.refresh(true), sleep(4500).then(() => null)]);
    line('Clima', w ? `${w.city || 'sua região'}, ${w.temp} °C` : 'sem dados agora', w ? 'ok' : 'off');
    if (!w) world.refresh(true).then(updateClock);
    updateClock();
  }
  await sleep(Math.max(0, 1700 - (performance.now() - t0)));
  jarvis.greet();
  setTimeout(() => {
    box.classList.add('hide');
    setTimeout(() => { box.hidden = true; }, 900);
  }, 3200);
  const hi = settings.weather && world.weather
    ? world.greeting(who())
    : `${greetingWord()}, ${who()}. ${spokenTime()}. Em que posso ajudar?`;
  await say(hi);
  if (state === 'booting') idle();
}

// Mantém a tela do celular acesa enquanto o JARVIS está ligado
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* sem suporte */ }
}
document.addEventListener('visibilitychange', () => {
  // o navegador solta a trava quando a aba fica escondida; pede de novo ao voltar
  if (document.visibilityState === 'visible' && state !== 'off' && (!wakeLock || wakeLock.released)) keepAwake();
});

// ---------- Microfone e teclado ----------
function toggleMic() {
  micPaused = !micPaused;
  $('btnMic').classList.toggle('off', micPaused);
  $('btnMic').title = micPaused ? 'Ligar o microfone (M)' : 'Pausar o microfone (M)';
  if (state === 'listening' || state === 'hearing' || state === 'paused') idle();
}
$('btnMic').addEventListener('click', () => { if (state !== 'off') toggleMic(); });

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('settings').classList.remove('show');
    return;
  }
  if (state === 'off' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (document.querySelector('.modal.show:not(.start)') || e.target.closest('input, select, textarea')) return;
  // Espaço sempre interrompe, mesmo com um botão do topo em foco (sem "clicar" nele)
  if (e.code === 'Space') { e.preventDefault(); interrupt(); return; }
  if (e.target.closest('button')) return;
  if (e.code === 'KeyM') toggleMic();
  else if (e.code === 'KeyC') $('btnCam').click();
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' && state !== 'off' && e.target.closest('button') && !document.querySelector('.modal.show:not(.start)')) e.preventDefault();
});

// ---------- Câmera e mãos ----------
const CAM_ERRORS = {
  NotAllowedError: 'A permissão da câmera foi negada. Dá para mexer nos hologramas com o mouse ou o dedo.',
  NotFoundError: 'Nenhuma câmera foi encontrada. Dá para mexer nos hologramas com o mouse ou o dedo.',
  NotReadableError: 'A câmera está sendo usada por outro programa.',
  Insecure: 'A câmera só funciona em endereço https.',
  Unsupported: 'Este navegador não permite acesso à câmera.',
};

async function startCamera() {
  const btn = $('btnCam');
  btn.disabled = true;
  try {
    const loading = hands.startCamera();
    $('preview').classList.add('show');
    await loading;
    btn.classList.remove('off');
    btn.title = 'Desligar a câmera (C)';
    $('btnCalib').disabled = false;
    $('btnCalib').title = '';
    if (projector.models.length) showHint(true);
    return true;
  } catch (e) {
    hands.stopCamera();
    $('preview').classList.remove('show');
    note(CAM_ERRORS[e.name] || 'Não foi possível iniciar o rastreamento das mãos.', 9000);
    return false;
  } finally {
    btn.disabled = false;
  }
}

function stopCamera() {
  hands.stopCamera();
  $('preview').classList.remove('show');
  $('btnCam').classList.add('off');
  $('btnCam').title = 'Ligar a câmera (C)';
  $('btnCalib').disabled = true;
  updateHint();
}

$('btnCam').addEventListener('click', () => {
  if (hands.isCameraOn()) { stopCamera(); save({ camera: false }); } else { startCamera(); save({ camera: true }); }
});

// A dica de gestos aparece por alguns segundos quando surge um holograma (e quando a câmera liga)
let hintUntil = 0;
let hintShows = 0;
function showHint(force = false) {
  if (!force && hintShows >= 3) return;
  hintShows++;
  hintUntil = performance.now() + 14000;
  updateHint();
  setTimeout(updateHint, 14100);
}

function updateHint() {
  const el = $('hint');
  el.hidden = !projector.models.length || narrow.matches || performance.now() > hintUntil;
  if (el.hidden) return;
  el.innerHTML = hands.isCameraOn()
    ? '<b>Pinça</b> pega o holograma · <b>pinça rápida</b> separa as peças<br><b>Pinça com o dedo médio</b> pega uma peça<br><b>Duas mãos</b> giram e mudam o tamanho<br><b>Arremesse</b> para descartar'
    : '<b>Arraste</b> para mover · <b>clique</b> separa as peças<br><b>Botão direito</b> pega uma peça · <b>rodinha</b> muda o tamanho<br><b>Arremesse</b> para descartar';
}
narrow.addEventListener?.('change', updateHint);

// ---------- Pegar hologramas e peças ----------
const grab = new GrabSystem(projector.models, { gravity: false, pickRadius: 150, minDepth: 3, maxDepth: 14 });
const partGrab = new GrabSystem([], { gravity: false, twoHand: false, minDepth: 2.5, maxDepth: 14 });
const heldParts = new Map(); // grabber -> { part, parent }

projector.onRemove = (m) => {
  grab.forget(m);
  // peça solta na mão de alguém cujo modelo sumiu: some junto
  for (const [g, h] of [...heldParts]) {
    let o = h.parent;
    while (o && o !== m) o = o.parent;
    if (o !== m) continue;
    partGrab.release(g, false);
    heldParts.delete(g);
    scene.remove(h.part);
  }
  setTimeout(updateHint, 0);
};

function hitsRobot(x, y) {
  const r = raycast(x, y, jarvis.meshes(), false);
  if (!r) return false;
  const m = raycast(x, y, projector.models, true);
  return !m || r.distance < m.distance;
}

function robotTouch() {
  if (state === 'speaking' || state === 'thinking') { interrupt(); return; }
  if (state === 'paused') toggleMic();
  jarvis.spin();
  sfx?.chirp();
}

function modelOf(o) {
  while (o && !projector.models.includes(o)) o = o.parent;
  return o || null;
}

// Rastro recente de cada mão/mouse, para medir a velocidade do arremesso
const trails = new WeakMap();
function trackPointer(g, now = performance.now()) {
  let tr = trails.get(g);
  if (!tr) trails.set(g, (tr = []));
  tr.push({ t: now, x: g.x, y: g.y });
  while (tr.length > 2 && now - tr[0].t > 150) tr.shift();
}

function flingVelocity(g, m, now) {
  const tr = trails.get(g);
  if (!tr?.length) return null;
  const old = tr.find((p) => now - p.t <= 130) || tr[tr.length - 1];
  const dt = (now - old.t) / 1000;
  if (dt < 0.02) return null;
  if (Math.hypot(g.x - old.x, g.y - old.y) / dt < FLING_PX) return null;
  const d = depthOf(m.position);
  return pointAt(g.x, g.y, d, new THREE.Vector3()).sub(pointAt(old.x, old.y, d, new THREE.Vector3())).divideScalar(dt);
}

// t: horário do evento (o do próprio evento do mouse, que continua certo mesmo se a página estiver lenta)
function pinchStart(g, kind, t = performance.now()) {
  projector.touched();
  g.downAt = t;
  g.downX = g.x;
  g.downY = g.y;
  trails.set(g, [{ t: g.downAt, x: g.x, y: g.y }]);
  if (kind === 'index') {
    grab.objects = projector.models;
    if (grab.grab(g)) return;
    if (g.kind === 'hand' && hitsRobot(g.x, g.y)) robotTouch();
    return;
  }
  const hit = raycast(g.x, g.y, projector.parts(), false);
  if (!hit) return;
  const part = hit.object;
  const parent = part.parent;
  scene.attach(part);
  part.userData.held = 1;
  partGrab.objects = [part];
  if (partGrab.grab(g)) heldParts.set(g, { part, parent });
  else { parent.attach(part); part.userData.held = 0; }
}

function pinchEnd(g, kind, t = performance.now()) {
  projector.touched();
  const quick = t - (g.downAt || 0) < 320 && Math.hypot(g.x - g.downX, g.y - g.downY) < 14;
  if (kind === 'index') {
    trackPointer(g, t);
    const m = grab.grips.get(g)?.obj;
    const paired = m && grab.pairs.has(m);
    grab.release(g, false);
    if (!m || paired || m.userData.held) return;
    if (quick) {
      // toque rápido: separa as peças (ou junta de novo)
      m.userData.exploded = !m.userData.exploded;
      m.userData.home = true;
      sfx?.ack();
      return;
    }
    const vel = flingVelocity(g, m, t);
    if (vel) {
      projector.fling(m, vel);
      sfx?.dismiss();
    }
    return;
  }
  const h = heldParts.get(g);
  if (!h) return;
  partGrab.release(g, false);
  heldParts.delete(g);
  h.part.userData.held = 0;
  h.parent.attach(h.part);
  projector.partMoved(h.part);
}

hands.onPinch(pinchStart, pinchEnd);

// O que cada mão está fazendo, para o desenho da mão na tela
const handTmp = new THREE.Vector3();
function handInfo(h) {
  const m = grab.heldBy(h);
  const part = heldParts.get(h)?.part;
  const obj = m || part;
  let target = null, pair = null;
  if (obj) {
    const s = toScreen(obj.getWorldPosition(handTmp));
    if (!s.behind) target = s;
  }
  if (m && grab.pairs.has(m)) {
    const other = hands.hands.find((o) => o !== h && o.present && grab.heldBy(o) === m);
    if (other) pair = { x: other.x, y: other.y };
  }
  return { hold: m ? 'model' : part ? 'part' : null, target, hover: !!h.hover, pair };
}

// Mouse e toque: esquerdo/dedo = pinça (holograma), direito = dedo médio (peça), rodinha = tamanho.
// Dois dedos no mesmo holograma giram e mudam o tamanho, como as duas mãos.
const mouse = { kind: 'mouse', present: false, x: -1, y: -1, size: 0, roll: undefined, pinchKind: null };
const touches = new Map();

function pointerOf(e) {
  if (e.pointerType === 'mouse') return mouse;
  let g = touches.get(e.pointerId);
  if (!g) {
    g = { kind: 'touch', present: true, x: e.clientX, y: e.clientY, size: 0, roll: undefined, pinchKind: null };
    touches.set(e.pointerId, g);
  }
  return g;
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  const g = pointerOf(e);
  Object.assign(g, { x: e.clientX, y: e.clientY, present: true });
  if (g.pinchKind) return;
  if (hitsRobot(e.clientX, e.clientY)) { robotTouch(); return; }
  g.pinchKind = e.button === 2 ? 'middle' : 'index';
  try { canvas.setPointerCapture(e.pointerId); } catch { /* ponteiro já liberado */ }
  pinchStart(g, g.pinchKind, e.timeStamp);
});
canvas.addEventListener('pointermove', (e) => {
  const g = e.pointerType === 'mouse' ? mouse : touches.get(e.pointerId);
  if (!g) return;
  g.x = e.clientX;
  g.y = e.clientY;
  if (g === mouse) mouse.present = true;
  if (g.pinchKind) trackPointer(g, e.timeStamp);
});
const endPointer = (e) => {
  const g = e.pointerType === 'mouse' ? mouse : touches.get(e.pointerId);
  if (!g) return;
  if (g.pinchKind) {
    const k = g.pinchKind;
    g.pinchKind = null;
    g.x = e.clientX;
    g.y = e.clientY;
    pinchEnd(g, k, e.timeStamp);
  }
  if (g !== mouse) { g.present = false; touches.delete(e.pointerId); }
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !mouse.pinchKind) mouse.present = false; });
canvas.addEventListener('wheel', (e) => {
  const hit = raycast(e.clientX, e.clientY, projector.models, true);
  const o = hit && modelOf(hit.object);
  if (!o || o.userData.build < 1) return;
  e.preventDefault();
  projector.touched();
  const base = o.userData.base;
  o.scale.setScalar(THREE.MathUtils.clamp(o.scale.x * Math.exp(-e.deltaY * 0.001), base * 0.3, base * 3));
}, { passive: false });

function pointers() {
  const list = hands.hands.filter((h) => h.present);
  if (mouse.present) list.push(mouse);
  for (const t of touches.values()) list.push(t);
  return list;
}

// Nome da peça sob a mão (ou o mouse) e carinho no robô
const tag = $('tag');
function updateHover() {
  const free = pointers().filter((g) => !g.pinchKind && g.kind !== 'touch');
  let pet = false;
  let shown = false;
  for (const h of hands.hands) if (h.pinchKind || !h.present) h.hover = false;
  for (const g of free) {
    if (!pet && hitsRobot(g.x, g.y)) pet = true;
    const hit = projector.models.length ? raycast(g.x, g.y, projector.parts(), false) : null;
    g.hover = !!hit; // a mira da mão "trava" em cima do holograma
    if (shown || !hit) continue;
    shown = true;
    if (tag.textContent !== hit.object.name) tag.textContent = hit.object.name;
    tag.style.left = g.x + 'px';
    tag.style.top = g.y + 'px';
  }
  tag.hidden = !shown;
  if (pet && !jarvis.pet && state !== 'off') sfx?.chirp();
  jarvis.pet = pet;
  $('preview').classList.toggle('tracking', hands.hands.some((h) => h.present));
}

// ---------- Etiquetas do holograma (nome do modelo e peças citadas) ----------
const SVGNS = 'http://www.w3.org/2000/svg';
const labelLayer = $('labels');
const hudSvg = $('hud');
const modelLabels = new Map();
const MAX_LINKS = 4; // linhas por etiqueta (ex.: "Bobinas" aponta para várias bobinas)
const callouts = Array.from({ length: 3 }, () => {
  const el = document.createElement('div');
  el.className = 'callout';
  labelLayer.append(el);
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('class', 'lead');
  const links = Array.from({ length: MAX_LINKS }, () => {
    const line = document.createElementNS(SVGNS, 'polyline');
    const dot = document.createElementNS(SVGNS, 'circle');
    dot.setAttribute('r', '3.5');
    g.append(line, dot);
    return { line, dot };
  });
  g.style.opacity = '0';
  hudSvg.append(g);
  return { el, g, links, name: '', w: 0 };
});
const wp = new THREE.Vector3();

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// x da etiqueta na tela, sem deixar ela passar da borda (os créditos dos modelos baixados são compridos)
function labelX(el, sx) {
  const half = Math.max(90, el.offsetWidth / 2 + 12);
  return Math.min(innerWidth - half, Math.max(half, sx));
}

function updateHud() {
  for (const m of projector.models) {
    let el = modelLabels.get(m);
    if (!el) {
      el = document.createElement('div');
      el.className = 'mlabel';
      el.innerHTML = '<b></b><span></span>';
      el.firstChild.textContent = m.name;
      labelLayer.append(el);
      modelLabels.set(m, el);
      requestAnimationFrame(() => el.classList.add('show'));
    }
    const u = m.userData;
    wp.copy(m.position);
    wp.y += (u.height * (1 + u.explode * 0.8) * m.scale.x) / 2 + 0.3;
    const s = toScreen(wp);
    const x = labelX(el, s.x);
    const y = Math.max(narrow.matches ? 150 : 120, s.y);
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    // some se cair atrás do cartão de música
    const underCard = card && y < card.bottom && x > card.left - 80 && x < card.right + 80;
    el.style.visibility = s.behind || u.held || underCard ? 'hidden' : '';
    const n = u.partNames.length;
    const info = u.build < 1 ? 'Montando holograma' : u.exploded ? `Vista explodida · ${n} peças` : `${n} ${n === 1 ? 'peça' : 'peças'}`;
    setText(el.lastChild, u.fonte && u.build >= 1 ? `${info} · ${u.fonte}` : info);
  }
  // holograma de "carregando": nome do modelo e progresso
  const ld = projector.loader;
  if (ld) {
    let el = modelLabels.get(ld);
    if (!el) {
      el = document.createElement('div');
      el.className = 'mlabel';
      el.innerHTML = '<b></b><span></span>';
      labelLayer.append(el);
      modelLabels.set(ld, el);
      requestAnimationFrame(() => el.classList.add('show'));
    }
    setText(el.firstChild, ld.userData.nome || '');
    setText(el.lastChild, ld.userData.text || '');
    wp.copy(ld.position);
    wp.y += 1.35 * ld.scale.x;
    const s = toScreen(wp);
    el.style.transform = `translate(${labelX(el, s.x).toFixed(1)}px, ${Math.max(narrow.matches ? 150 : 120, s.y).toFixed(1)}px) translate(-50%, -100%)`;
    el.style.opacity = ld.userData.on ? '' : '0';
  }
  for (const [m, el] of modelLabels) {
    if (!projector.models.includes(m) && m !== ld) { el.remove(); modelLabels.delete(m); }
  }

  // peças que o JARVIS está citando: etiqueta com linhas até as peças
  const groups = projector.highlightGroups().slice(0, callouts.length);
  const used = [];
  let minY = narrow.matches ? 160 : 110;
  // no celular o cartão de música ocupa o topo: as etiquetas ficam abaixo dele
  if (narrow.matches && card) minY = Math.max(minY, card.bottom + 22);
  callouts.forEach((c, i) => {
    const grp = groups[i];
    if (!grp) {
      c.el.classList.remove('show');
      c.g.style.opacity = '0';
      return;
    }
    const pts = grp.parts.slice(0, MAX_LINKS)
      .map((p) => toScreen(p.userData.anchor ? p.localToWorld(wp.copy(p.userData.anchor)) : p.getWorldPosition(wp)))
      .filter((q) => !q.behind);
    if (!pts.length) return;
    const a = pts.reduce((best, q) => (q.y < best.y ? q : best)); // a peça mais alta recebe a etiqueta
    const m = modelOf(grp.parts[0]);
    const center = m ? toScreen(m.position) : a;
    if (c.name !== grp.label) {
      c.name = grp.label;
      c.el.textContent = grp.label;
      c.w = c.el.offsetWidth;
    }
    let right = a.x >= center.x - 4;
    if (right && a.x + 70 + c.w > innerWidth - 8) right = false;
    else if (!right && a.x - 70 - c.w < 8) right = true;
    let ly = Math.max(minY, a.y - 46);
    for (const y of used) if (Math.abs(ly - y) < 32) ly = y + 32;
    used.push(ly);
    const lx = a.x + (right ? 70 : -70);
    const ex = a.x + (right ? 30 : -30);
    c.el.style.transform = `translate(${(right ? lx : lx - c.w).toFixed(1)}px, ${(ly - 13).toFixed(1)}px)`;
    c.links.forEach((k, j) => {
      const q = pts[j];
      k.line.style.display = k.dot.style.display = q ? '' : 'none';
      if (!q) return;
      k.line.setAttribute('points', q === a
        ? `${q.x.toFixed(1)},${q.y.toFixed(1)} ${ex.toFixed(1)},${ly.toFixed(1)} ${lx.toFixed(1)},${ly.toFixed(1)}`
        : `${q.x.toFixed(1)},${q.y.toFixed(1)} ${ex.toFixed(1)},${ly.toFixed(1)}`);
      k.line.style.opacity = q === a ? '' : '0.45';
      k.dot.setAttribute('cx', q.x.toFixed(1));
      k.dot.setAttribute('cy', q.y.toFixed(1));
    });
    c.el.classList.add('show');
    c.g.style.opacity = '1';
  });
}

// ---------- Configurações ----------
const dlg = $('settings');
const voiceSel = $('setVoice');

function fillVoices() {
  const a = voice ? voice.available(settings) : {};
  const order = ['piper', 'eleven', 'microsoft', 'sistema', 'auto'];
  voiceSel.replaceChildren(...order.map((id) => {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = ENGINE_LABELS[id];
    if (id === 'microsoft' && voice && !a.microsoft) o.textContent += ' (indisponível neste navegador)';
    return o;
  }));
  voiceSel.value = settings.voice;
  updateVoiceInfo();
}

function updateVoiceInfo() {
  $('elevenBox').hidden = !(voiceSel.value === 'eleven' || (voiceSel.value === 'auto' && settings.elevenKey));
  if (!voice) { $('voiceInfo').textContent = 'Clique em Iniciar para testar as vozes.'; return; }
  const tmp = { ...settings, voice: voiceSel.value, elevenKey: $('setEleven').value.trim() };
  const engine = voice.resolve(tmp);
  const detail = voice.describe(engine);
  $('voiceInfo').textContent = `Vai usar: ${ENGINE_LABELS[engine]}${detail ? ' (' + detail + ')' : ''}`;
}

function fillElevenSelect(list) {
  const sel = $('setElevenVoice');
  const opts = list.length ? list : [{ id: settings.elevenVoice, name: 'Daniel (padrão)', desc: '' }];
  sel.replaceChildren(...opts.map((v) => {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.desc ? `${v.name} (${v.desc})` : v.name;
    return o;
  }));
  sel.value = opts.some((v) => v.id === settings.elevenVoice) ? settings.elevenVoice : opts[0].id;
}

function renderMemory() {
  const list = memory.list();
  const ul = $('memList');
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nada ainda. Diga, por exemplo: "Jarvis, lembra que eu gosto de astronomia".';
    ul.replaceChildren(li);
    $('btnForgetAll').disabled = true;
    return;
  }
  $('btnForgetAll').disabled = false;
  ul.replaceChildren(...list.map((f, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = f;
    const b = document.createElement('button');
    b.title = 'Esquecer';
    b.setAttribute('aria-label', 'Esquecer este item');
    b.innerHTML = X_ICON.replace('<svg', '<svg width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"');
    b.addEventListener('click', () => { memory.remove(i); renderMemory(); });
    li.append(span, b);
    return li;
  }));
}

$('btnSettings').addEventListener('click', () => {
  $('setGroq').value = settings.groqKey;
  $('setSketchfab').value = settings.sketchfabKey;
  $('sketchfabResult').textContent = '';
  $('sketchfabResult').className = 'result';
  $('setEleven').value = settings.elevenKey;
  $('setName').value = settings.name;
  $('setWake').checked = settings.wake;
  $('setWeather').checked = settings.weather;
  $('setSounds').checked = settings.sounds;
  $('groqResult').textContent = models ? `Conectado. Conversa: ${models.chat[0]}. Transcrição: ${models.stt}.` : '';
  $('groqResult').className = 'result' + (models ? ' ok' : '');
  $('voiceResult').textContent = '';
  fillElevenSelect([]);
  fillVoices();
  renderMemory();
  dlg.classList.add('show');
});
voiceSel.addEventListener('change', updateVoiceInfo);
$('setEleven').addEventListener('input', updateVoiceInfo);
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.classList.remove('show'); });
$('btnForgetAll').addEventListener('click', () => {
  if (!confirm('Esquecer tudo o que o JARVIS lembra sobre você?')) return;
  memory.clear();
  renderMemory();
});

$('btnTestGroq').addEventListener('click', async () => {
  const r = $('groqResult');
  r.className = 'result';
  r.textContent = 'Testando...';
  try {
    const m = await pickModels($('setGroq').value.trim());
    r.className = 'result ok';
    r.textContent = `Funciona. Conversa: ${m.chat[0]}. Transcrição: ${m.stt}.`;
  } catch (e) {
    r.className = 'result err';
    r.textContent = e.message;
  }
});

$('btnTestSketchfab').addEventListener('click', async () => {
  const r = $('sketchfabResult');
  const token = $('setSketchfab').value.trim();
  if (!token) { r.className = 'result err'; r.textContent = 'Cole o token primeiro.'; return; }
  r.className = 'result';
  r.textContent = 'Testando...';
  try {
    const conta = await (await sketchfab()).checkToken(token);
    r.className = 'result ok';
    r.textContent = `Funciona. Conta: ${conta}.`;
  } catch (e) {
    r.className = 'result err';
    r.textContent = e.message || 'Não consegui testar agora.';
  }
});

$('btnLoadVoices').addEventListener('click', async () => {
  const r = $('voiceResult');
  r.className = 'result';
  r.textContent = 'Carregando vozes...';
  try {
    const list = await elevenVoices($('setEleven').value.trim());
    fillElevenSelect(list);
    r.className = 'result ok';
    r.textContent = `${list.length} vozes disponíveis na sua conta.`;
  } catch (e) {
    r.className = 'result err';
    r.textContent = e.message;
  }
});

$('btnHear').addEventListener('click', async () => {
  const r = $('voiceResult');
  if (!voice) { r.className = 'result err'; r.textContent = 'Clique em Iniciar primeiro.'; return; }
  const tmp = { ...settings, voice: voiceSel.value, elevenKey: $('setEleven').value.trim(), elevenVoice: $('setElevenVoice').value };
  const engine = voice.resolve(tmp);
  r.className = 'result';
  r.textContent = '';
  if (engine === 'piper' && !voice.piperCached) {
    r.textContent = 'Baixando a voz neural (63 MB, só na primeira vez)...';
    await voice.preparePiper();
    if (!voice.piperCached) { r.className = 'result err'; r.textContent = 'Não consegui baixar a voz neural.'; return; }
    r.textContent = '';
    updateVoiceInfo();
  }
  const myTurn = ++turn;
  if (state !== 'off') setState('speaking');
  await voice.say(`Olá, ${who()}. Eu sou o JARVIS, e esta é a minha voz.`, tmp);
  if (myTurn === turn && state === 'speaking') idle();
});

$('btnSaveSettings').addEventListener('click', async () => {
  const newKey = $('setGroq').value.trim();
  const patch = {
    voice: voiceSel.value,
    elevenKey: $('setEleven').value.trim(),
    elevenVoice: $('setElevenVoice').value || settings.elevenVoice,
    name: $('setName').value.trim(),
    wake: $('setWake').checked,
    weather: $('setWeather').checked,
    sounds: $('setSounds').checked,
  };
  if (newKey && newKey !== settings.groqKey) {
    try {
      models = await pickModels(newKey);
      patch.groqKey = newKey;
    } catch (e) {
      $('groqResult').className = 'result err';
      $('groqResult').textContent = e.message;
      return;
    }
  }
  // token do Sketchfab: vazio desliga a busca; um token recusado não é salvo
  const skToken = $('setSketchfab').value.trim();
  if (skToken && skToken !== settings.sketchfabKey) {
    try {
      await (await sketchfab()).checkToken(skToken);
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        $('sketchfabResult').className = 'result err';
        $('sketchfabResult').textContent = e.message;
        return;
      }
    }
  }
  patch.sketchfabKey = skToken;
  const weatherOn = patch.weather && !settings.weather;
  save(patch);
  if (sfx) sfx.enabled = settings.sounds;
  if (weatherOn && state !== 'off') world.refresh(true).then(updateClock);
  updateClock();
  if (state === 'listening') setState('listening');
  dlg.classList.remove('show');
});

$('btnWipe').addEventListener('click', async () => {
  if (!confirm('Apagar as chaves, as configurações, a memória, a voz e os modelos baixados deste navegador?')) return;
  wipe();
  memory.clear();
  try { await caches.delete(PIPER_CACHE); } catch { /* sem Cache API */ }
  try { await (await sketchfab()).clearModels(); } catch { /* sem Cache API */ }
  location.reload();
});

// ---------- Calibração da mão ----------
const calibDlg = $('calib');
let calibAbort = null;
$('btnCalib').addEventListener('click', async () => {
  if (!hands.isTracking()) return;
  dlg.classList.remove('show');
  calibDlg.classList.add('show');
  $('calibDone').hidden = true;
  $('calibCancel').hidden = false;
  calibAbort = new AbortController();
  const bar = $('calibBar');
  try {
    await hands.calibrate(({ text, progress }) => {
      $('calibText').textContent = text;
      bar.style.width = Math.round(progress * 100) + '%';
    }, calibAbort.signal);
    $('calibText').textContent = 'Pronto. Sua pinça foi calibrada e fica salva neste navegador.';
    bar.style.width = '100%';
  } catch (e) {
    if (calibAbort.signal.aborted) { calibDlg.classList.remove('show'); return; }
    $('calibText').textContent = e.message;
  }
  $('calibCancel').hidden = true;
  $('calibDone').hidden = false;
});
$('calibCancel').addEventListener('click', () => calibAbort?.abort());
$('calibDone').addEventListener('click', () => calibDlg.classList.remove('show'));
$('calibReset').addEventListener('click', () => { hands.resetCalib(); $('calibText').textContent = 'Calibração padrão restaurada.'; });

// ---------- Onde cada um fica ----------
// Sem holograma: o JARVIS no centro. Com holograma: ele vai para o lado e o modelo fica no projetor.
const platTarget = new THREE.Vector3();
// Retângulo do cartão de música na tela, medido só quando ele aparece, some ou muda de lugar
let card = null;
let cardDirty = true;
const markCard = () => { cardDirty = true; };
new MutationObserver(markCard).observe(music.el, { attributes: true, attributeFilter: ['hidden'] });
new MutationObserver(markCard).observe($('timers'), { childList: true });
addEventListener('resize', markCard);

function placeCast(dt, t) {
  const loading = !!projector.loader?.userData.on;
  const has = projector.models.length > 0 || loading;
  const off = state === 'off';
  const musicOn = !music.el.hidden;
  if (cardDirty) {
    cardDirty = false;
    card = musicOn ? music.el.getBoundingClientRect() : null;
  }
  let lift = off ? (portrait ? -2.2 : -1.25) : 0;
  if (portrait) {
    // celular em pé: holograma em cima, robô embaixo à esquerda (mais baixo se o cartão de música ocupa o topo)
    if (!has) jarvis.setPlace(0, off ? -0.4 : 0.4, 1.05);
    else if (musicOn) jarvis.setPlace(-1.2, 3.6, 0.5);
    else jarvis.setPlace(-1.0, 2.7, 0.6);
    projector.setCenter(has ? 0.25 : 0, musicOn ? 1.6 : 2.9);
    // com o cartão de música no topo, a cena desce até o holograma aparecer inteiro abaixo dele
    if (has && card && !off) {
      let top = 0;
      for (const m of projector.models) top = Math.max(top, m.userData.target.y + (m.userData.height * m.userData.base) / 2);
      lift = liftFor(top, card.bottom + 18);
    }
  } else {
    jarvis.setPlace(has ? -3.4 : 0, has ? 0.4 : off ? -0.8 : 0.6, has ? 0.9 : 1.2);
    projector.setCenter(has ? 0.9 : 0, 1.5);
  }
  setLift(lift);
  platTarget.set(projector.centerX, 0.01, 0);
  platform.position.lerp(platTarget, 1 - Math.exp(-dt * 3));
  platform.visible = has;
  const building = loading || projector.models.some((m) => m.userData.build < 1);
  platform.rotation.y += dt * (building ? 0.9 : 0.06);
  const u = platform.userData;
  u.ringMat.opacity += ((building ? 1 : 0.6 + 0.08 * Math.sin(t * 1.5)) - u.ringMat.opacity) * Math.min(1, dt * 5);
  u.discMat.opacity += ((building ? 0.32 : 0.14) - u.discMat.opacity) * Math.min(1, dt * 5);
}

const lookTmp = new THREE.Vector3();
function lookTarget() {
  const g = pointers()[0];
  if (g) return pointAt(g.x, g.y, 6, lookTmp);
  if (projector.models.length && state !== 'listening' && state !== 'hearing') return projector.models[0].position;
  return null;
}

// ---------- Medidor de áudio no topo ----------
const meterBars = [...$('meter').children];
const METER_W = [0.5, 0.8, 1, 0.75, 0.45];
let meterLast = '';
function updateMeter(t, level) {
  let lv = 0;
  if (state === 'speaking') lv = level * 1.5;
  else if (state === 'listening' || state === 'hearing') lv = Math.min(1, level * 16);
  else if (state === 'thinking' || state === 'booting') lv = 0.4 + 0.2 * Math.sin(t * 7);
  const key = lv.toFixed(2);
  if (key === meterLast && lv === 0) return;
  meterLast = key;
  meterBars.forEach((b, i) => {
    const v = Math.max(0.12, Math.min(1, lv * METER_W[i] * (0.7 + 0.3 * Math.sin(t * 12 + i * 1.9))));
    b.style.transform = `scaleY(${v.toFixed(3)})`;
  });
}

// ---------- Loop ----------
function onResize() {
  resize();
  hands.resizeOverlay();
  updateHint();
}
addEventListener('resize', onResize);
onResize();

const clock = new THREE.Clock();
let frameNo = 0;
function frame() {
  requestAnimationFrame(frame); // agenda antes: um erro num quadro não congela a tela
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  frameNo++;
  hands.detect();
  for (const h of hands.hands) if (h.present && h.pinchKind) trackPointer(h);
  grab.update(dt);
  partGrab.update(dt);
  projector.update(dt);
  updateCamera(dt);
  hands.drawHands(handInfo);
  if (frameNo % 3 === 0) updateHover();
  const level = state === 'speaking' ? voice?.level() || 0 : ear?.level || 0;
  placeCast(dt, t);
  jarvis.beat = music.beat();
  jarvis.update(dt, state === 'booting' ? 'listening' : state, level, lookTarget());
  renderer.render(scene, camera);
  updateHud();
  updateCaption();
  updateMeter(t, level);
  if (!music.el.hidden && frameNo % 10 === 0) $('mBar').style.width = `${(music.progress() * 100).toFixed(2)}%`;
}
requestAnimationFrame(frame);

// Ganchos só para testes automatizados (?debug)
if (debug) {
  window.__jarvis = {
    projector, brain, hands, mouse, camera, settings, jarvis, grab, partGrab, music, timers, memory, world,
    get voice() { return voice; },
    get ear() { return ear; },
    get sfx() { return sfx; },
    get models() { return models; },
    setState: (s) => setState(s),
    getState: () => state,
    respond: (t) => respond(t),
    onUtterance: (w) => onUtterance(w),
    routeUtterance: (w) => routeUtterance(w),
    bargeCheck: (w, early) => bargeCheck(w, early),
    get bargeWoke() { return bargeWoke; },
    say: (t) => say(t),
    applyCommands: (c) => applyCommands(c),
    command: (raw) => applyCommands(sanitizeCommands(raw)),
    interrupt: () => interrupt(),
  };
}
