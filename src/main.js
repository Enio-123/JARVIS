import * as THREE from 'three';
import { canvas, renderer, scene, camera, resize, updateCamera, raycast, pointAt, platform, portrait } from './stage.js';
import * as hands from './hands.js';
import { GrabSystem } from './grab.js';
import { Projector } from './projector.js';
import { Brain, pickModel, transcribe } from './brain.js';
import { Ear } from './ear.js';
import { Voice, ENGINE_LABELS, elevenVoices } from './voice.js';
import { Character } from './character.js';
import { settings, save, wipe } from './settings.js';

const $ = (id) => document.getElementById(id);
const debug = new URLSearchParams(location.search).has('debug');

// ---------- Estado da conversa ----------
// off | listening | hearing | thinking | speaking | paused
let state = 'off';
let models = null; // { chat, stt } escolhidos para a chave
let audioCtx = null;
let ear = null;
let voice = null;
let micPaused = false;
let lastReplyAt = 0;
let busy = false;
const brain = new Brain();
const projector = new Projector();
const jarvis = new Character();

const STATUS = {
  off: ['', 'Desligado'],
  listening: ['listen', 'Ouvindo'],
  hearing: ['listen', 'Ouvindo você...'],
  thinking: ['busy', 'Pensando'],
  speaking: ['speak', 'Falando'],
  paused: ['', 'Microfone pausado'],
};

function setState(s) {
  state = s;
  const [cls, text] = STATUS[s];
  $('dot').className = 'dot ' + cls;
  $('status').textContent = text;
  ear?.setEnabled(s === 'listening' || s === 'hearing');
}

function idle() {
  setState(micPaused ? 'paused' : 'listening');
}

function caption({ you, him, note } = {}) {
  if (you !== undefined) $('capYou').textContent = you ? `Você: ${you}` : '';
  if (him !== undefined) $('capHim').textContent = him;
  if (note !== undefined) $('capNote').textContent = note;
}

function fail(message) {
  $('dot').className = 'dot err';
  caption({ note: message });
}

// ---------- Ciclo: ouvir -> transcrever -> pensar -> falar ----------
const WAKE = /\b(j[aá]rv[ia]s|jarvas|javis|jarbas|djarvis)\b/i;

async function onUtterance(wav) {
  if (busy) return;
  busy = true;
  setState('thinking');
  try {
    const text = await transcribe(settings.groqKey, models.stt, wav);
    if (!text) return;
    if (settings.wake && !WAKE.test(text) && performance.now() - lastReplyAt > 12000) return;
    await respond(text);
  } catch (e) {
    fail(e.message);
  } finally {
    busy = false;
    if (state === 'thinking') idle();
  }
}

async function respond(text) {
  caption({ you: text, note: '' });
  setState('thinking');
  const out = await brain.reply({
    key: settings.groqKey,
    model: models.chat,
    text,
    name: settings.name,
    sceneDesc: projector.describe(),
  });
  projector.apply(out.cena, out.modelo);
  if (out.modelo && $('hint').hidden && hands.isCameraOn()) $('hint').hidden = false;
  await say(out.fala);
}

async function say(text) {
  if (!text) return idle();
  caption({ him: text });
  setState('speaking');
  await voice.speak(text, settings);
  lastReplyAt = performance.now();
  // pequena pausa para o eco da própria voz não ser captado
  await new Promise((r) => setTimeout(r, 300));
  if (state === 'speaking') idle();
}

function interrupt() {
  if (state === 'speaking') {
    voice.stop();
    idle();
  } else if (state === 'paused') {
    toggleMic();
  }
}

// ---------- Início ----------
const startKey = $('startKey');
$('startKeyField').hidden = !!settings.groqKey;
$('startCam').checked = settings.camera;

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
    // destrava a voz do navegador dentro do clique (exigência do Chrome/Safari)
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
    voice ||= new Voice(audioCtx);
    voice.onNote = (t) => caption({ note: t });
    const [picked] = await Promise.all([pickModel(key), voice.init()]);
    models = picked;
    save({ groqKey: key, camera: $('startCam').checked });
    startKey.value = '';

    ear ||= new Ear(audioCtx);
    ear.onUtterance = onUtterance;
    ear.onSpeechStart = () => { if (state === 'listening') setState('hearing'); };
    if (!ear.active) {
      try {
        await ear.start();
      } catch (e) {
        throw new Error(MIC_ERRORS[e.name] || 'Não consegui ligar o microfone.');
      }
    }
    $('start').classList.remove('show');
    if (settings.camera) startCamera();
    if (voice.resolve(settings) === 'piper' && !voice.piperCached) voice.preparePiper();
    const name = settings.name?.trim() || 'senhor';
    jarvis.greet();
    await say(`Online e às suas ordens, ${name}.`);
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

const MIC_ERRORS = {
  NotAllowedError: 'A permissão do microfone foi negada. Libere o microfone para este site e tente de novo.',
  NotFoundError: 'Nenhum microfone foi encontrado.',
  NotReadableError: 'O microfone está sendo usado por outro programa.',
};

// ---------- Microfone ----------
function toggleMic() {
  micPaused = !micPaused;
  $('btnMic').classList.toggle('off', micPaused);
  $('btnMic').title = micPaused ? 'Ligar o microfone' : 'Pausar o microfone';
  if (state === 'listening' || state === 'hearing' || state === 'paused') idle();
}
$('btnMic').addEventListener('click', () => { if (state !== 'off') toggleMic(); });
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.target.closest('input, select, button, textarea') && state !== 'off') {
    e.preventDefault();
    interrupt();
  }
});

// ---------- Câmera e mãos ----------
const CAM_ERRORS = {
  NotAllowedError: 'A permissão da câmera foi negada. Dá para mexer nos modelos com o mouse.',
  NotFoundError: 'Nenhuma câmera foi encontrada. Dá para mexer nos modelos com o mouse.',
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
    btn.title = 'Desligar a câmera';
    $('btnCalib').disabled = false;
    $('btnCalib').title = '';
    if (projector.models.length) $('hint').hidden = false;
  } catch (e) {
    hands.stopCamera();
    $('preview').classList.remove('show');
    caption({ note: CAM_ERRORS[e.name] || 'Não foi possível iniciar o rastreamento das mãos.' });
  } finally {
    btn.disabled = false;
  }
}

function stopCamera() {
  hands.stopCamera();
  $('preview').classList.remove('show');
  $('btnCam').classList.add('off');
  $('btnCam').title = 'Ligar a câmera (mãos)';
  $('btnCalib').disabled = true;
  $('hint').hidden = true;
}

$('btnCam').addEventListener('click', () => {
  if (hands.isCameraOn()) { stopCamera(); save({ camera: false }); } else { startCamera(); save({ camera: true }); }
});

// ---------- Pegar modelos e peças ----------
const grab = new GrabSystem(projector.models, { gravity: false, pickRadius: 150, minDepth: 3, maxDepth: 14 });
const partGrab = new GrabSystem([], { gravity: false, twoHand: false, minDepth: 2.5, maxDepth: 14 });
const heldParts = new Map(); // grabber -> { part, parent }
projector.onRemove = (m) => grab.forget(m);

function pinchStart(g, kind) {
  projector.touched();
  if (kind === 'index') {
    grab.objects = projector.models;
    grab.grab(g);
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

function pinchEnd(g, kind) {
  projector.touched();
  if (kind === 'index') {
    grab.release(g, false);
    return;
  }
  const h = heldParts.get(g);
  if (!h) return;
  partGrab.release(g, false);
  heldParts.delete(g);
  h.part.userData.held = 0;
  h.parent.attach(h.part);
}

hands.onPinch(pinchStart, pinchEnd);

// Mouse: botão esquerdo = pinça (modelo), direito = dedo médio (peça), rodinha = tamanho
const mouse = { kind: 'mouse', present: false, x: -1, y: -1, size: 0, roll: undefined, pinchKind: null };
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  Object.assign(mouse, { x: e.clientX, y: e.clientY, present: true });
  if (mouse.pinchKind) return;
  // tocar no JARVIS interrompe a fala (ou religa o microfone)
  if (raycast(e.clientX, e.clientY, jarvis.meshes(), false)) { interrupt(); return; }
  mouse.pinchKind = e.button === 2 ? 'middle' : 'index';
  try { canvas.setPointerCapture(e.pointerId); } catch { /* ponteiro já liberado */ }
  pinchStart(mouse, mouse.pinchKind);
});
canvas.addEventListener('pointermove', (e) => {
  Object.assign(mouse, { x: e.clientX, y: e.clientY, present: e.pointerType === 'mouse' || !!mouse.pinchKind });
});
const endMouse = () => {
  if (!mouse.pinchKind) return;
  const k = mouse.pinchKind;
  mouse.pinchKind = null;
  pinchEnd(mouse, k);
};
canvas.addEventListener('pointerup', endMouse);
canvas.addEventListener('pointercancel', endMouse);
canvas.addEventListener('pointerleave', (e) => { if (!mouse.pinchKind && e.pointerType === 'mouse') mouse.present = false; });
canvas.addEventListener('wheel', (e) => {
  const hit = raycast(e.clientX, e.clientY, projector.models, true);
  if (!hit) return;
  let o = hit.object;
  while (o && !projector.models.includes(o)) o = o.parent;
  if (!o || o.userData.appear < 1) return;
  e.preventDefault();
  projector.touched();
  const base = o.userData.base;
  o.scale.setScalar(THREE.MathUtils.clamp(o.scale.x * Math.exp(-e.deltaY * 0.001), base * 0.3, base * 3));
}, { passive: false });

// Nome da peça sob a mão (ou o mouse)
const tag = $('tag');
function updateTag() {
  const g = hands.hands.find((h) => h.present && !h.pinchKind) || (mouse.present && !mouse.pinchKind ? mouse : null);
  const hit = g && projector.models.length ? raycast(g.x, g.y, projector.parts(), false) : null;
  if (!hit) { tag.hidden = true; return; }
  tag.hidden = false;
  tag.textContent = hit.object.name;
  tag.style.left = g.x + 'px';
  tag.style.top = g.y + 'px';
}

// ---------- Configurações ----------
const dlg = $('settings');
const voiceSel = $('setVoice');

function fillVoices() {
  const a = voice ? voice.available(settings) : {};
  voiceSel.replaceChildren(...Object.entries(ENGINE_LABELS).map(([id, label]) => {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = label;
    if (id === 'microsoft' && voice && !a.microsoft) o.textContent += ' (indisponível neste navegador)';
    return o;
  }));
  voiceSel.value = settings.voice;
  updateVoiceInfo();
}

function updateVoiceInfo() {
  $('elevenBox').hidden = !(voiceSel.value === 'eleven' || (voiceSel.value === 'auto' && settings.elevenKey));
  if (!voice) { $('voiceInfo').textContent = ''; return; }
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

$('btnSettings').addEventListener('click', () => {
  $('setGroq').value = settings.groqKey;
  $('setEleven').value = settings.elevenKey;
  $('setName').value = settings.name;
  $('setWake').checked = settings.wake;
  $('groqResult').textContent = models ? `Conectado. Conversa: ${models.chat}. Transcrição: ${models.stt}.` : '';
  $('groqResult').className = 'result' + (models ? ' ok' : '');
  $('voiceResult').textContent = '';
  fillElevenSelect([]);
  fillVoices();
  dlg.classList.add('show');
});
voiceSel.addEventListener('change', updateVoiceInfo);
$('setEleven').addEventListener('input', updateVoiceInfo);
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.classList.remove('show'); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') dlg.classList.remove('show'); });

$('btnTestGroq').addEventListener('click', async () => {
  const r = $('groqResult');
  r.className = 'result';
  r.textContent = 'Testando...';
  try {
    const m = await pickModel($('setGroq').value.trim());
    r.className = 'result ok';
    r.textContent = `Funciona. Conversa: ${m.chat}. Transcrição: ${m.stt}.`;
  } catch (e) {
    r.className = 'result err';
    r.textContent = e.message;
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
  r.textContent = engine === 'piper' && !voice.piperCached ? 'Baixando a voz neural, pode levar um pouco...' : '';
  if (engine === 'piper' && !voice.piperCached) {
    await voice.preparePiper();
    if (!voice.piperCached) { r.className = 'result err'; r.textContent = 'Não consegui baixar a voz neural.'; return; }
    r.textContent = '';
    updateVoiceInfo();
  }
  const prev = state;
  if (state === 'listening' || state === 'hearing') setState('speaking');
  await voice.speak('Olá. Eu sou o JARVIS, e esta é a minha voz. Em que posso ajudar?', tmp);
  if (prev !== 'off' && state === 'speaking') idle();
});

$('btnSaveSettings').addEventListener('click', async () => {
  const newKey = $('setGroq').value.trim();
  const patch = {
    voice: voiceSel.value,
    elevenKey: $('setEleven').value.trim(),
    elevenVoice: $('setElevenVoice').value || settings.elevenVoice,
    name: $('setName').value.trim(),
    wake: $('setWake').checked,
  };
  if (newKey && newKey !== settings.groqKey) {
    try {
      models = await pickModel(newKey);
      patch.groqKey = newKey;
    } catch (e) {
      $('groqResult').className = 'result err';
      $('groqResult').textContent = e.message;
      return;
    }
  }
  save(patch);
  dlg.classList.remove('show');
});

$('btnWipe').addEventListener('click', async () => {
  if (!confirm('Apagar as chaves, as configurações e a voz baixada deste navegador?')) return;
  wipe();
  try { await caches.delete('jarvisvoz-piper-v1'); } catch { /* sem Cache API */ }
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
// Sem modelo: o JARVIS no centro. Com modelo: ele vai para o lado e o modelo fica no centro do projetor.
const platTarget = new THREE.Vector3();
function placeCast(dt) {
  const has = projector.models.length > 0;
  const off = state === 'off';
  if (portrait) {
    jarvis.setPlace(has ? -1.25 : 0, has ? 2.6 : off ? -0.4 : 0.4, has ? 0.72 : 1.05);
    projector.setCenter(has ? 0.35 : 0, 2);
  } else {
    jarvis.setPlace(has ? -3.4 : 0, has ? 0.4 : off ? -0.8 : 0.6, has ? 0.9 : 1.2);
    projector.setCenter(has ? 0.9 : 0, 1.5);
  }
  platTarget.set(projector.centerX, 0.01, 0);
  platform.position.lerp(platTarget, 1 - Math.exp(-dt * 3));
  platform.visible = has;
  platform.rotation.y += dt * 0.05;
}

const lookTmp = new THREE.Vector3();
function lookTarget() {
  const g = hands.hands.find((h) => h.present) || (mouse.present ? mouse : null);
  if (g) return pointAt(g.x, g.y, 6, lookTmp);
  if (projector.models.length && state !== 'listening' && state !== 'hearing') return projector.models[0].position;
  return null;
}

// ---------- Loop ----------
function onResize() {
  resize();
  hands.resizeOverlay();
}
addEventListener('resize', onResize);
onResize();

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  hands.detect();
  grab.update(dt);
  partGrab.update(dt);
  projector.update(dt);
  updateCamera(dt);
  hands.drawHands();
  updateTag();
  const level = state === 'speaking' ? voice.level() : ear?.level || 0;
  placeCast(dt);
  jarvis.update(dt, state, level, lookTarget());
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Ganchos só para testes automatizados (?debug)
if (debug) {
  window.__jarvis = {
    projector, brain, hands, mouse, camera, settings, jarvis, grab,
    setState: (s) => setState(s),
    getState: () => state,
    getVoice: () => voice,
    getEar: () => ear,
    respond: (t) => respond(t),
    onUtterance: (w) => onUtterance(w),
  };
}
