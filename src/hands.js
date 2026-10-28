// Câmera + rastreamento das mãos (MediaPipe Hand Landmarker)
// Melhorias de detecção:
// - filtro One Euro em cada ponto da mão (tira o tremido sem deixar lento)
// - pinça medida em 3D (coordenadas do mundo da mão), então funciona com a mão de lado ou longe
// - tolerância a perdas curtas: se a mão some por menos de 250 ms, nada é solto
// - calibração: aprende a sua mão aberta e a sua pinça e ajusta os limites
const video = document.getElementById('video');
const overlay = document.getElementById('hands');
const octx = overlay.getContext('2d');

let landmarker = null;
let stream = null;
let lastVideoTime = -1;
let calibrating = false;
const LOST_GRACE = 0.25;

const CALIB_KEY = 'jarvisvoz.calib';
const DEFAULT_CALIB = { on: 0.3, off: 0.45, custom: false };
export const calib = { ...DEFAULT_CALIB, ...loadCalib() };

function loadCalib() {
  try { return JSON.parse(localStorage.getItem(CALIB_KEY)) || {}; } catch { return {}; }
}
function saveCalib() {
  try { localStorage.setItem(CALIB_KEY, JSON.stringify(calib)); } catch { /* sem armazenamento */ }
}
export function resetCalib() {
  Object.assign(calib, DEFAULT_CALIB);
  try { localStorage.removeItem(CALIB_KEY); } catch { /* sem armazenamento */ }
}

// ---------- Filtro One Euro ----------
class OneEuro {
  constructor(minCutoff = 1.6, beta = 0.012, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: 0 });
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
  reset() { this.x = null; this.dx = 0; }
}

function newHand(id) {
  return {
    kind: 'hand', id, present: false, lastSeen: 0,
    x: 0, y: 0, tipX: 0, tipY: 0, size: 0, roll: 0,
    ri: 1, rm: 1, pinchKind: null, offCount: 0, pts: null,
    fx: Array.from({ length: 21 }, () => new OneEuro()),
    fy: Array.from({ length: 21 }, () => new OneEuro()),
  };
}
export const hands = [newHand(0), newHand(1)];

const handlers = { start: () => {}, end: () => {} };
export function onPinch(start, end) {
  handlers.start = start;
  handlers.end = end;
}

export const isCameraOn = () => !!stream;
export const isTracking = () => !!stream && !!landmarker;

// Converte coordenadas normalizadas do vídeo para a tela (espelhado, como um espelho)
function toScreen(lm) {
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const s = Math.max(innerWidth / vw, innerHeight / vh);
  const ox = (vw * s - innerWidth) / 2, oy = (vh * s - innerHeight) / 2;
  return { x: (1 - lm.x) * vw * s - ox, y: lm.y * vh * s - oy };
}

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

function readHand(landmarks, world) {
  const raw = landmarks.map(toScreen);
  const w = world && world.length === 21 ? world : landmarks;
  const palm = dist3(w[0], w[9]) || 1;
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  return {
    raw,
    wx: raw[0].x, wy: raw[0].y,
    ri: dist3(w[4], w[8]) / palm,
    rm: dist3(w[4], w[12]) / palm,
    size: Math.hypot((landmarks[9].x - landmarks[0].x) * vw, (landmarks[9].y - landmarks[0].y) * vh) / vh,
  };
}

const mid = (p, a, b) => ({ x: (p[a].x + p[b].x) / 2, y: (p[a].y + p[b].y) / 2 });

function setPoint(h) {
  const m = h.pinchKind === 'middle' ? mid(h.pts, 4, 12) : mid(h.pts, 4, 8);
  h.x = m.x;
  h.y = m.y;
}

function updatePinch(h) {
  if (calibrating) return;
  if (!h.pinchKind) {
    if (Math.min(h.ri, h.rm) < calib.on) {
      h.pinchKind = h.ri <= h.rm * 1.15 ? 'index' : 'middle';
      h.offCount = 0;
      setPoint(h);
      handlers.start(h, h.pinchKind);
    }
    return;
  }
  const r = h.pinchKind === 'index' ? h.ri : h.rm;
  if (r > calib.off) {
    // precisa de 2 quadros seguidos abertos para soltar (evita soltar sem querer)
    if (++h.offCount >= 2) {
      const k = h.pinchKind;
      h.pinchKind = null;
      handlers.end(h, k);
    }
  } else {
    h.offCount = 0;
  }
}

function lose(h) {
  if (h.pinchKind) {
    const k = h.pinchKind;
    h.pinchKind = null;
    handlers.end(h, k);
  }
  h.present = false;
  h.pts = null;
}

// Mantém cada mão no mesmo "slot" entre quadros, para não trocar o objeto de mão
function assign(dets, t) {
  const cost = (h, d) => (h.present ? Math.hypot(h.pts[0].x - d.wx, h.pts[0].y - d.wy) : 400);
  let order = [0, 1];
  if (dets.length === 2) {
    const straight = cost(hands[0], dets[0]) + cost(hands[1], dets[1]);
    const swapped = cost(hands[0], dets[1]) + cost(hands[1], dets[0]);
    if (swapped < straight) order = [1, 0];
  } else if (dets.length === 1) {
    order = cost(hands[1], dets[0]) < cost(hands[0], dets[0]) ? [1] : [0];
  }
  const used = new Set();
  dets.forEach((d, i) => {
    const h = hands[order[i]];
    used.add(h);
    if (!h.present) {
      h.fx.forEach((f) => f.reset());
      h.fy.forEach((f) => f.reset());
      h.size = d.size;
    }
    h.present = true;
    h.lastSeen = t;
    h.pts = d.raw.map((p, k) => ({ x: h.fx[k].filter(p.x, t), y: h.fy[k].filter(p.y, t) }));
    h.size += (d.size - h.size) * 0.35;
    h.roll = Math.atan2(h.pts[17].y - h.pts[5].y, h.pts[17].x - h.pts[5].x);
    h.ri = d.ri;
    h.rm = d.rm;
    h.tipX = h.pts[8].x;
    h.tipY = h.pts[8].y;
    setPoint(h);
    updatePinch(h);
  });
  for (const h of hands) {
    if (used.has(h) || !h.present) continue;
    if (t - h.lastSeen > LOST_GRACE) lose(h);
  }
}

export function detect() {
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const now = performance.now();
  const res = landmarker.detectForVideo(video, now);
  const lms = res.landmarks || [];
  const world = res.worldLandmarks || [];
  assign(lms.map((lm, i) => readHand(lm, world[i])), now / 1000);
}

export async function startCamera() {
  if (!window.isSecureContext) throw Object.assign(new Error(), { name: 'Insecure' });
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(), { name: 'Unsupported' });
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  if (!landmarker) {
    const { FilesetResolver, HandLandmarker } = await import('../vendor/vision_bundle.mjs');
    const base = new URL('../', import.meta.url);
    const fileset = await FilesetResolver.forVisionTasks(new URL('vendor', base).href);
    const options = (delegate) => ({
      baseOptions: {
        // O modelo (.task) é salvo com extensão .wasm só para a hospedagem servir o arquivo binário
        modelAssetPath: new URL('models/hand_landmarker.wasm', base).href,
        delegate,
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'));
    } catch {
      landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
    }
  }
}

export function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  lastVideoTime = -1;
  hands.forEach(lose);
}

// ---------- Calibração ("treinar" a sua mão) ----------
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function collect(key, seconds, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const samples = [];
    let elapsed = 0, last = performance.now();
    const tick = () => {
      if (signal.aborted) return reject(new Error('cancelado'));
      const now = performance.now();
      const h = hands.find((x) => x.present);
      if (h) {
        elapsed += (now - last) / 1000;
        samples.push(h[key]);
      }
      last = now;
      onProgress(Math.min(1, elapsed / seconds), !!h);
      if (elapsed >= seconds) resolve(samples);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function calibrate(onStep, signal) {
  hands.forEach((h) => { if (h.pinchKind) { const k = h.pinchKind; h.pinchKind = null; handlers.end(h, k); } });
  calibrating = true;
  try {
    const step = (text) => (p, seen) => onStep({ text: seen ? text : 'Mostre a mão para a câmera...', progress: p });
    const open = await collect('ri', 2, step('Mão aberta, dedos afastados. Segure assim...'), signal);
    onStep({ text: 'Agora junte a ponta do polegar com a ponta do indicador.', progress: 0 });
    await new Promise((r) => setTimeout(r, 1200));
    const pinch = await collect('ri', 2, step('Pinça fechada. Segure assim...'), signal);
    const o = median(open), p = median(pinch);
    if (!(o - p > 0.2)) throw new Error('Não consegui diferenciar a mão aberta da pinça. Tente de novo com a mão mais perto e bem iluminada.');
    calib.on = p + (o - p) * 0.3;
    calib.off = p + (o - p) * 0.5;
    calib.custom = true;
    saveCalib();
    return { open: o, pinch: p };
  } finally {
    calibrating = false;
  }
}

// ---------- Desenho das mãos sobre a cena ----------
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

export function resizeOverlay() {
  const dpr = Math.min(devicePixelRatio, 2);
  overlay.width = innerWidth * dpr;
  overlay.height = innerHeight * dpr;
}

export function drawHands() {
  const dpr = Math.min(devicePixelRatio, 2);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, innerWidth, innerHeight);
  for (const h of hands) {
    if (!h.present || !h.pts) continue;
    octx.strokeStyle = 'rgba(255,255,255,0.5)';
    octx.lineWidth = 2;
    octx.beginPath();
    for (const [a, b] of BONES) {
      octx.moveTo(h.pts[a].x, h.pts[a].y);
      octx.lineTo(h.pts[b].x, h.pts[b].y);
    }
    octx.stroke();
    octx.fillStyle = 'rgba(255,255,255,0.8)';
    for (const p of h.pts) {
      octx.beginPath();
      octx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      octx.fill();
    }
    // Cursor da pinça: azul = indicador, âmbar = dedo médio
    const color = h.pinchKind === 'middle' ? '#f2a541' : '#4c8dff';
    octx.beginPath();
    octx.arc(h.x, h.y, h.pinchKind ? 9 : 14, 0, Math.PI * 2);
    octx.lineWidth = 2;
    octx.strokeStyle = h.pinchKind ? color : 'rgba(255,255,255,0.9)';
    octx.stroke();
    if (h.pinchKind) {
      octx.fillStyle = h.pinchKind === 'middle' ? 'rgba(242,165,65,0.35)' : 'rgba(76,141,255,0.35)';
      octx.fill();
    }
  }
}

// Ganchos para testes automatizados
export const _test = { assign };
