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
    vis: { appearAt: 0, snapAt: -9, releaseAt: -9, hoverAt: -9, hover: false, ghost: null, lostAt: 0, trail: [] },
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
      h.vis.snapAt = performance.now() / 1000;
      h.vis.trail.length = 0;
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
      h.vis.releaseAt = performance.now() / 1000;
      h.vis.releaseKind = k;
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
  // a mão some aos poucos em vez de desaparecer de uma vez
  if (h.pts) {
    h.vis.ghost = { pts: h.pts, size: h.size, x: h.x, y: h.y };
    h.vis.lostAt = performance.now() / 1000;
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
      // mão nova na câmera: animação de "mão detectada"
      if (t - h.vis.lostAt > 0.6) h.vis.appearAt = t;
      h.vis.ghost = null;
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
// Holograma da mão no estilo do HUD: palma translúcida com o "repulsor" no centro, dedos com brilho,
// juntas e pontas marcadas, a pinça "carregando" conforme o polegar se aproxima, um estalo quando ela
// fecha, a mira que trava em cima do holograma e uma linha até o que a mão está segurando.
const FINGERS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [0, 17, 18, 19, 20]];
const PALM = [0, 1, 5, 9, 13, 17];
const TIPS = [4, 8, 12, 16, 20];
const CYAN = '92,208,255';
const AMBER = '242,165,65';
const CORE = '214,244,255';

export function resizeOverlay() {
  const dpr = Math.min(devicePixelRatio, 2);
  overlay.width = innerWidth * dpr;
  overlay.height = innerHeight * dpr;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const ease = (v) => 1 - Math.pow(1 - clamp01(v), 3);

// Contorno de cada dedo (da base até a ponta) e largura em relação ao comprimento da palma
const FINGER_SHAPES = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const FINGER_W = [0.26, 0.21, 0.22, 0.21, 0.18];
const TAPER = [1, 0.9, 0.82, 0.74];

// Dedo como um tubo achatado que afina até a ponta arredondada (entra no mesmo caminho da palma)
function fingerShape(ctx, chain, width) {
  const left = [], right = [];
  let dx = 0, dy = 0;
  chain.forEach((p, j) => {
    const prev = chain[Math.max(0, j - 1)], next = chain[Math.min(chain.length - 1, j + 1)];
    dx = next.x - prev.x;
    dy = next.y - prev.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const w = (width * TAPER[j]) / 2;
    left.push({ x: p.x - dy * w, y: p.y + dx * w });
    right.push({ x: p.x + dy * w, y: p.y - dx * w });
  });
  const tip = chain[chain.length - 1];
  const a = Math.atan2(dy, dx);
  ctx.moveTo(left[0].x, left[0].y);
  for (let j = 1; j < left.length; j++) ctx.lineTo(left[j].x, left[j].y);
  ctx.arc(tip.x, tip.y, (width * TAPER[chain.length - 1]) / 2, a + Math.PI / 2, a - Math.PI / 2, true);
  for (let j = right.length - 2; j >= 0; j--) ctx.lineTo(right[j].x, right[j].y);
  ctx.closePath();
}

// Liga os pontos com curvas suaves (a palma fica arredondada)
function smoothPath(ctx, pts, closed, begin = true) {
  const n = pts.length;
  const at = (i) => pts[(i + n) % n];
  if (begin) ctx.beginPath();
  const m0 = closed ? { x: (at(-1).x + at(0).x) / 2, y: (at(-1).y + at(0).y) / 2 } : at(0);
  ctx.moveTo(m0.x, m0.y);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p = at(i), q = at(i + 1);
    ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
  }
  if (closed) ctx.closePath();
}

// Quanto a pinça está perto de fechar (0 = aberta, 1 = fechada)
function closeness(r) {
  const open = calib.off * 1.35;
  return clamp01((open - r) / (open - calib.on));
}

// info(h) → { hold: 'model' | 'part' | null, target: { x, y } | null, hover: bool, pair: { x, y } | null }
export function drawHands(info = () => ({})) {
  const dpr = Math.min(devicePixelRatio, 2);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, innerWidth, innerHeight);
  const t = performance.now() / 1000;
  octx.lineCap = 'round';
  octx.lineJoin = 'round';
  for (const h of hands) {
    if (h.present && h.pts) {
      drawHand(h, h.pts, h.size, ease((t - h.vis.appearAt) / 0.45), t, info(h) || {});
    } else if (h.vis.ghost) {
      const k = 1 - (t - h.vis.lostAt) / 0.35;
      if (k <= 0) h.vis.ghost = null;
      else drawHand(h, h.vis.ghost.pts, h.vis.ghost.size, k, t, {}, true);
    }
  }
}

function drawHand(h, pts, size, a, t, info, ghost = false) {
  const ctx = octx;
  const k = Math.max(0.65, Math.min(1.6, size / 0.2)); // mão perto da câmera = traços maiores
  const kind = h.pinchKind || (t - h.vis.releaseAt < 0.3 ? h.vis.releaseKind : null);
  const rgb = kind === 'middle' ? AMBER : CYAN;
  const born = t - h.vis.appearAt;
  const scanning = !ghost && born < 0.7;

  // volume da mão: palma e dedos preenchidos de leve (parece uma luva holográfica), com contorno
  const palm = PALM.map((i) => pts[i]);
  const pc = { x: (pts[0].x + pts[5].x + pts[9].x + pts[13].x + pts[17].x) / 5, y: (pts[0].y + pts[5].y + pts[9].y + pts[13].y + pts[17].y) / 5 };
  const L = Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y) + 1;
  const grad = ctx.createRadialGradient(pc.x, pc.y, 0, pc.x, pc.y, L * 1.6);
  grad.addColorStop(0, `rgba(${CYAN},${0.2 * a})`);
  grad.addColorStop(1, `rgba(${CYAN},${0.05 * a})`);
  ctx.beginPath();
  smoothPath(ctx, palm, true, false);
  FINGER_SHAPES.forEach((chain, i) => fingerShape(ctx, chain.map((j) => pts[j]), L * FINGER_W[i]));
  ctx.fillStyle = grad;
  ctx.fill('nonzero');
  ctx.strokeStyle = `rgba(${CYAN},${0.42 * a})`;
  ctx.lineWidth = 1;
  ctx.stroke();

  // ossos dos dedos: núcleo claro com um brilho suave em volta
  for (const pass of [0, 1]) {
    for (const f of FINGERS) {
      for (let j = 0; j < f.length - 1; j++) {
        const p = pts[f[j]], q = pts[f[j + 1]];
        const taper = 1 - (j / (f.length - 1)) * 0.45;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        if (pass === 0) {
          ctx.strokeStyle = `rgba(${CYAN},${0.12 * a})`;
          ctx.lineWidth = 6 * k * taper;
        } else {
          ctx.strokeStyle = `rgba(${CORE},${0.8 * a})`;
          ctx.lineWidth = 1.6 * k * taper;
        }
        ctx.stroke();
      }
    }
  }

  // juntas e pontas dos dedos
  for (let i = 1; i < 21; i++) {
    const p = pts[i];
    const tip = TIPS.includes(i);
    ctx.beginPath();
    ctx.arc(p.x, p.y, (tip ? 2.8 : i % 4 === 1 ? 2.6 : 1.9) * k, 0, Math.PI * 2);
    ctx.fillStyle = tip ? `rgba(255,255,255,${0.95 * a})` : `rgba(${CYAN},${0.9 * a})`;
    ctx.fill();
    if (tip) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5.5 * k, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${CYAN},${0.4 * a})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // repulsor na palma: acende mais forte quando a mão está segurando algo
  const live = h.pinchKind ? 1 : 0.45;
  ctx.beginPath();
  ctx.arc(pc.x, pc.y, 4.2 * k, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${CORE},${0.75 * live * a})`;
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = `rgba(${rgb},${0.8 * live * a})`;
  for (let s = 0; s < 4; s++) {
    const ang = t * (h.pinchKind ? 3 : 1.2) + (s * Math.PI) / 2;
    ctx.beginPath();
    ctx.arc(pc.x, pc.y, 9 * k, ang, ang + 0.9);
    ctx.stroke();
  }

  // linha de varredura quando a mão acaba de aparecer
  if (scanning) {
    let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
    for (const p of pts) { y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); }
    const sy = y1 - (y1 - y0 + 30) * ease(born / 0.7) + 15;
    const g2 = ctx.createLinearGradient(x0 - 20, 0, x1 + 20, 0);
    g2.addColorStop(0, `rgba(${CYAN},0)`);
    g2.addColorStop(0.5, `rgba(${CYAN},${0.9 * (1 - born / 0.7)})`);
    g2.addColorStop(1, `rgba(${CYAN},0)`);
    ctx.fillStyle = g2;
    ctx.fillRect(x0 - 20, sy - 1, x1 - x0 + 40, 2);
  }
  if (ghost) return;

  // pinça "carregando": linha entre o polegar e o dedo que vai fechar, com o arco enchendo
  const useMiddle = h.pinchKind ? h.pinchKind === 'middle' : h.rm < h.ri * 0.87;
  const other = pts[useMiddle ? 12 : 8];
  const c = h.pinchKind ? 1 : closeness(useMiddle ? h.rm : h.ri);
  const prgb = useMiddle ? AMBER : CYAN;
  if (!h.pinchKind && c > 0.05) {
    ctx.beginPath();
    ctx.moveTo(pts[4].x, pts[4].y);
    ctx.lineTo(other.x, other.y);
    ctx.strokeStyle = `rgba(${prgb},${0.25 + 0.6 * c})`;
    ctx.lineWidth = 1 + 1.5 * c;
    ctx.setLineDash([3, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // mira no ponto da pinça
  const x = h.x, y = h.y;
  const R = 15 * Math.max(0.85, Math.min(1.3, k));
  if (h.pinchKind) {
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${rgb},0.35)`;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${rgb},0.95)`;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, R + 2, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${rgb},0.55)`;
    ctx.stroke();
  } else {
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = `rgba(${prgb},0.9)`;
    for (let s = 0; s < 3; s++) {
      const ang = t * 1.6 + (s * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.arc(x, y, R, ang, ang + 1.25);
      ctx.stroke();
    }
    // arco que enche conforme a pinça fecha
    if (c > 0.05) {
      ctx.beginPath();
      ctx.arc(x, y, R + 5, -Math.PI / 2, -Math.PI / 2 + c * Math.PI * 2);
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = `rgba(${prgb},${0.35 + 0.6 * c})`;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${prgb},0.95)`;
    ctx.fill();
  }

  // trava na mira quando a mão está em cima do holograma
  if (info.hover && !h.pinchKind) {
    if (!h.vis.hover) h.vis.hoverAt = t;
    const e = ease((t - h.vis.hoverAt) / 0.18);
    const r2 = R + 9 + (1 - e) * 14;
    ctx.strokeStyle = `rgba(${CYAN},${0.9 * e})`;
    ctx.lineWidth = 2;
    for (let s = 0; s < 4; s++) {
      const ang = Math.PI / 4 + (s * Math.PI) / 2;
      const cx = x + Math.cos(ang) * r2, cy = y + Math.sin(ang) * r2;
      const dx = -Math.sign(Math.cos(ang)) * 7, dy = -Math.sign(Math.sin(ang)) * 7;
      ctx.beginPath();
      ctx.moveTo(cx + dx, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy);
      ctx.stroke();
    }
  }
  h.vis.hover = !!info.hover && !h.pinchKind;

  // estalo quando a pinça fecha e quando solta
  const snap = t - h.vis.snapAt;
  if (snap < 0.4) {
    ctx.beginPath();
    ctx.arc(x, y, 10 + ease(snap / 0.4) * 26, 0, Math.PI * 2);
    ctx.lineWidth = 2.5 * (1 - snap / 0.4);
    ctx.strokeStyle = `rgba(${rgb},${0.9 * (1 - snap / 0.4)})`;
    ctx.stroke();
  }
  const rel = t - h.vis.releaseAt;
  if (rel < 0.3) {
    ctx.beginPath();
    ctx.arc(x, y, 30 - ease(rel / 0.3) * 18, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(${rgb},${0.7 * (1 - rel / 0.3)})`;
    ctx.stroke();
  }

  // segurando: rastro do movimento e linha até o que está na mão
  const tr = h.vis.trail;
  if (h.pinchKind && info.hold) {
    tr.push({ x, y, t });
    while (tr.length && t - tr[0].t > 0.22) tr.shift();
    for (let i = 1; i < tr.length; i++) {
      const f = 1 - (t - tr[i].t) / 0.22;
      ctx.beginPath();
      ctx.moveTo(tr[i - 1].x, tr[i - 1].y);
      ctx.lineTo(tr[i].x, tr[i].y);
      ctx.lineWidth = 5 * f;
      ctx.strokeStyle = `rgba(${rgb},${0.35 * f})`;
      ctx.stroke();
    }
    const tg = info.target;
    if (tg && Math.hypot(tg.x - x, tg.y - y) > R + 6) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(tg.x, tg.y);
      ctx.setLineDash([2, 6]);
      ctx.lineDashOffset = -t * 40;
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = `rgba(${rgb},0.6)`;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.beginPath();
      ctx.arc(tg.x, tg.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rgb},0.9)`;
      ctx.fill();
    }
  } else {
    tr.length = 0;
  }

  // as duas mãos no mesmo holograma: barra entre elas (girar e mudar o tamanho)
  if (info.pair && h === hands[0]) {
    const p2 = info.pair;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(${CYAN},0.55)`;
    ctx.stroke();
    const mx = (x + p2.x) / 2, my = (y + p2.y) / 2;
    const ang = Math.atan2(p2.y - y, p2.x - x);
    ctx.beginPath();
    ctx.arc(mx, my, 11, ang - 1, ang + 1);
    ctx.arc(mx, my, 11, ang + Math.PI - 1, ang + Math.PI + 1);
    ctx.strokeStyle = `rgba(${CYAN},0.85)`;
    ctx.lineWidth = 2;
    ctx.stroke();
    // marcas de régua ao longo da barra
    const len = Math.hypot(p2.x - x, p2.y - y);
    for (let d = 24; d < len - 24; d += 18) {
      const qx = x + Math.cos(ang) * d, qy = y + Math.sin(ang) * d;
      ctx.beginPath();
      ctx.moveTo(qx - Math.sin(ang) * 3, qy + Math.cos(ang) * 3);
      ctx.lineTo(qx + Math.sin(ang) * 3, qy - Math.cos(ang) * 3);
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${CYAN},0.4)`;
      ctx.stroke();
    }
  }
}

// Ganchos para testes automatizados
export const _test = { assign };
