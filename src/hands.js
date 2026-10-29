// Câmera + rastreamento das mãos (MediaPipe Hand Landmarker)
// Gestos simples, que funcionam com qualquer webcam: mão fechada (punho) segura o holograma e mão
// aberta solta. Para isso ficar confiável:
// - o quanto a mão está fechada vem do ângulo das juntas dos dedos em 3D (coordenadas do mundo da
//   mão), então funciona com a mão de lado, perto ou longe da câmera
// - o "cursor" é o centro da palma, que quase não se mexe quando a mão fecha ou abre
// - filtro One Euro em cada ponto da mão (tira o tremido sem deixar lento)
// - histerese e alguns quadros de confirmação para fechar e para abrir (não solta sem querer)
// - tolerância a perdas curtas: se a mão some por menos de 250 ms, nada é solto
// - calibração opcional: aprende a sua mão aberta e o seu punho
const video = document.getElementById('video');
const overlay = document.getElementById('hands');
const octx = overlay.getContext('2d');

let landmarker = null;
let stream = null;
let lastVideoTime = -1;
let calibrating = false;
const LOST_GRACE = 0.25;
const GRIP_ON = 0.55; // fração do caminho entre a mão aberta e o punho que conta como "fechou"
const GRIP_OFF = 0.35; // e como "abriu"

const CALIB_KEY = 'jarvisvoz.calib2';
const DEFAULT_CALIB = { open: 0.6, fist: 3.6, custom: false }; // dobra média dos dedos, em radianos
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
const gripLevel = (f) => calib.open + (calib.fist - calib.open) * f;

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
    x: 0, y: 0, size: 0,
    curl: 0, front: 0, grip: false, onCount: 0, offCount: 0, pts: null,
    vis: { appearAt: 0, snapAt: -9, releaseAt: -9, hoverAt: -9, hover: false, ghost: null, lostAt: 0, trail: [] },
    fx: Array.from({ length: 21 }, () => new OneEuro()),
    fy: Array.from({ length: 21 }, () => new OneEuro()),
  };
}
export const hands = [newHand(0), newHand(1)];

const handlers = { start: () => {}, end: () => {} };
export function onGrip(start, end) {
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

// Ângulo (radianos) entre dois segmentos seguidos: 0 = reto
function bend(a, b, c) {
  const ux = b.x - a.x, uy = b.y - a.y, uz = (b.z || 0) - (a.z || 0);
  const vx = c.x - b.x, vy = c.y - b.y, vz = (c.z || 0) - (b.z || 0);
  const d = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / d)));
}

// Dobra de cada dedo (indicador, médio, anelar, mínimo): soma dos ângulos das três juntas
const FINGER_JOINTS = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
function curls(w) {
  return FINGER_JOINTS.map(([m, p, d, t]) => bend(w[0], w[m], w[p]) + bend(w[m], w[p], w[d]) + bend(w[p], w[d], w[t]));
}

function readHand(landmarks, world) {
  const raw = landmarks.map(toScreen);
  const w = world && world.length === 21 ? world : landmarks;
  const c = curls(w);
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  return {
    raw,
    wx: raw[0].x, wy: raw[0].y,
    curl: (c[0] + c[1] + c[2] + c[3]) / 4,
    front: Math.min(c[0], c[1]), // indicador e médio (apontar com o dedo não conta como mão fechada)
    size: Math.hypot((landmarks[9].x - landmarks[0].x) * vw, (landmarks[9].y - landmarks[0].y) * vh) / vh,
  };
}

// Centro da palma: punho e base dos dedos (fica parado quando a mão fecha)
const PALM_CENTER = [0, 5, 9, 13, 17];
function setPoint(h) {
  let x = 0, y = 0;
  for (const i of PALM_CENTER) { x += h.pts[i].x; y += h.pts[i].y; }
  h.x = x / PALM_CENTER.length;
  h.y = y / PALM_CENTER.length;
}

// Fecha com 2 quadros seguidos acima do limite e abre com 3 quadros seguidos abaixo
// (t = hora do quadro da câmera, em segundos)
function updateGrip(h, t) {
  if (calibrating) return;
  if (!h.grip) {
    const closed = h.curl >= gripLevel(GRIP_ON) && h.front >= gripLevel(GRIP_OFF);
    h.onCount = closed ? h.onCount + 1 : 0;
    if (h.onCount >= 2) {
      h.grip = true;
      h.offCount = 0;
      h.vis.snapAt = performance.now() / 1000;
      h.vis.trail.length = 0;
      handlers.start(h, t * 1000);
    }
    return;
  }
  if (h.curl > gripLevel(GRIP_OFF)) h.offCount = 0;
  else if (++h.offCount === 1) h.openAt = t; // quando a mão começou a abrir
  if (h.offCount >= 3) release(h, h.openAt);
}

// t = quando a mão abriu (s); lost = a mão sumiu ou a câmera parou (não conta como gesto)
function release(h, t, lost = false) {
  if (!h.grip) return;
  h.grip = false;
  h.onCount = 0;
  h.vis.releaseAt = performance.now() / 1000;
  handlers.end(h, t * 1000, lost);
}

function lose(h) {
  release(h, h.lastSeen, true);
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
      h.curl = d.curl;
      h.front = d.front;
      // mão nova na câmera: animação de "mão detectada"
      if (t - h.vis.lostAt > 0.6) h.vis.appearAt = t;
      h.vis.ghost = null;
    }
    h.present = true;
    h.lastSeen = t;
    h.pts = d.raw.map((p, k) => ({ x: h.fx[k].filter(p.x, t), y: h.fy[k].filter(p.y, t) }));
    h.size += (d.size - h.size) * 0.35;
    h.curl += (d.curl - h.curl) * 0.5;
    h.front += (d.front - h.front) * 0.5;
    setPoint(h);
    updateGrip(h, t);
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
  hands.forEach((h) => lose(h));
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
  hands.forEach((h) => release(h, h.lastSeen, true));
  calibrating = true;
  try {
    const step = (text) => (p, seen) => onStep({ text: seen ? text : 'Mostre a mão para a câmera...', progress: p });
    const open = await collect('curl', 2, step('Mão aberta, dedos esticados. Segure assim...'), signal);
    onStep({ text: 'Agora feche a mão, como se segurasse uma bola pequena.', progress: 0 });
    await new Promise((r) => setTimeout(r, 1200));
    const fist = await collect('curl', 2, step('Mão fechada. Segure assim...'), signal);
    const o = median(open), f = median(fist);
    if (!(f - o > 0.9)) throw new Error('Não consegui diferenciar a mão aberta da mão fechada. Tente de novo com a mão mais perto e bem iluminada.');
    calib.open = o;
    calib.fist = f;
    calib.custom = true;
    saveCalib();
    return { open: o, fist: f };
  } finally {
    calibrating = false;
  }
}

// ---------- Desenho das mãos sobre a cena ----------
// Holograma da mão no estilo do HUD: palma translúcida com o "repulsor" no centro (que é o cursor),
// dedos com brilho, juntas e pontas marcadas, o arco que enche conforme a mão fecha, um estalo quando
// ela fecha, a mira que trava em cima do holograma, setas de girar e uma linha até o que ela segura.
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

// Quanto a mão está perto de fechar (0 = aberta, 1 = fechou)
function closeness(h) {
  const open = gripLevel(0.12);
  return clamp01((h.curl - open) / (gripLevel(GRIP_ON) - open));
}

// Contorno da mão fechada: o fecho convexo dos pontos, estufado um pouco para fora (um punho limpo,
// em vez dos dedos dobrados uns sobre os outros)
function fistOutline(pts, pad) {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list) => {
    const out = [];
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    return out.slice(0, -1);
  };
  const hull = half(p).concat(half([...p].reverse()));
  const cx = hull.reduce((s, q) => s + q.x, 0) / hull.length, cy = hull.reduce((s, q) => s + q.y, 0) / hull.length;
  return hull.map((q) => {
    const d = Math.hypot(q.x - cx, q.y - cy) || 1;
    return { x: q.x + ((q.x - cx) / d) * pad, y: q.y + ((q.y - cy) / d) * pad };
  });
}

// info(h) → { hold: 'model' | null, target: { x, y } | null, hover: bool, pair: { x, y } | null, zoom: number }
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

// Setinha (chevron) apontando para fora do cursor, na direção ang
function chevron(ctx, x, y, r, ang, w) {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  ctx.beginPath();
  ctx.moveTo(x + dx * r - dy * w, y + dy * r + dx * w);
  ctx.lineTo(x + dx * (r + w), y + dy * (r + w));
  ctx.lineTo(x + dx * r + dy * w, y + dy * r - dx * w);
  ctx.stroke();
}

function drawHand(h, pts, size, a, t, info, ghost = false) {
  const ctx = octx;
  const k = Math.max(0.65, Math.min(1.6, size / 0.2)); // mão perto da câmera = traços maiores
  const gripping = !ghost && h.grip;
  const rgb = info.pair ? AMBER : CYAN;
  const born = t - h.vis.appearAt;
  const scanning = !ghost && born < 0.7;

  // volume da mão: palma e dedos preenchidos de leve (parece uma luva holográfica), com contorno.
  // Fechando, os dedos dobrados dão lugar ao contorno de um punho só.
  const palm = PALM.map((i) => pts[i]);
  const pc = { x: (pts[0].x + pts[5].x + pts[9].x + pts[13].x + pts[17].x) / 5, y: (pts[0].y + pts[5].y + pts[9].y + pts[13].y + pts[17].y) / 5 };
  const L = Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y) + 1;
  const shut = clamp01(((gripping ? 1 : closeness(h)) - 0.5) / 0.5);
  const grad = ctx.createRadialGradient(pc.x, pc.y, 0, pc.x, pc.y, L * 1.6);
  grad.addColorStop(0, `rgba(${gripping ? rgb : CYAN},${(gripping ? 0.3 : 0.2) * a})`);
  grad.addColorStop(1, `rgba(${gripping ? rgb : CYAN},${0.05 * a})`);
  ctx.fillStyle = grad;
  ctx.lineWidth = 1;
  if (shut < 1) {
    ctx.globalAlpha = 1 - shut;
    ctx.beginPath();
    smoothPath(ctx, palm, true, false);
    FINGER_SHAPES.forEach((chain, i) => fingerShape(ctx, chain.map((j) => pts[j]), L * FINGER_W[i]));
    ctx.fill('nonzero');
    ctx.strokeStyle = `rgba(${CYAN},${0.42 * a})`;
    ctx.stroke();
  }
  if (shut > 0) {
    ctx.globalAlpha = shut;
    smoothPath(ctx, fistOutline(pts, L * 0.16), true);
    ctx.fill();
    ctx.strokeStyle = `rgba(${gripping ? rgb : CYAN},${0.55 * a})`;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // ossos dos dedos: núcleo claro com um brilho suave em volta (mais discretos com a mão fechada)
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
          ctx.strokeStyle = `rgba(${CORE},${(0.8 - 0.35 * shut) * a})`;
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

  // cursor no centro da palma (o "repulsor"): o arco enche conforme a mão fecha e trava quando fecha
  const x = h.x, y = h.y;
  const R = 15 * Math.max(0.85, Math.min(1.3, k));
  const c = gripping ? 1 : closeness(h);
  if (gripping) {
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${rgb},0.3)`;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${rgb},0.95)`;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, R + 2, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${rgb},0.55)`;
    ctx.stroke();
    // setas para os quatro lados: mexer a mão fechada gira o holograma
    if (info.hold && !info.pair) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(${rgb},${0.6 + 0.25 * Math.sin(t * 5)})`;
      for (let s = 0; s < 4; s++) chevron(ctx, x, y, R + 8, (s * Math.PI) / 2, 5.5);
    }
  } else {
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = `rgba(${CYAN},0.9)`;
    for (let s = 0; s < 3; s++) {
      const ang = t * 1.6 + (s * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.arc(x, y, R, ang, ang + 1.25);
      ctx.stroke();
    }
    // arco que enche conforme a mão fecha
    if (c > 0.05) {
      ctx.beginPath();
      ctx.arc(x, y, R + 5, -Math.PI / 2, -Math.PI / 2 + c * Math.PI * 2);
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = `rgba(${CYAN},${0.35 + 0.6 * c})`;
      ctx.stroke();
    }
  }
  ctx.beginPath();
  ctx.arc(x, y, gripping ? 3.4 : 2.4, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${CORE},0.95)`;
  ctx.fill();

  // trava na mira quando a mão aberta está em cima do holograma
  if (info.hover && !gripping) {
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
  h.vis.hover = !!info.hover && !gripping;

  // estalo quando a mão fecha e quando abre
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

  // segurando: rastro do movimento e linha até o holograma
  const tr = h.vis.trail;
  if (gripping && info.hold) {
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
    if (tg && Math.hypot(tg.x - x, tg.y - y) > R + 16) {
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

  // as duas mãos fechadas: barra entre elas com o zoom
  if (info.pair && h === hands[0]) {
    const p2 = info.pair;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(${AMBER},0.6)`;
    ctx.stroke();
    const ang = Math.atan2(p2.y - y, p2.x - x);
    const len = Math.hypot(p2.x - x, p2.y - y);
    // marcas de régua ao longo da barra e setas nas pontas (afastar = aproximar)
    for (let d = 24; d < len - 24; d += 18) {
      const qx = x + Math.cos(ang) * d, qy = y + Math.sin(ang) * d;
      ctx.beginPath();
      ctx.moveTo(qx - Math.sin(ang) * 3, qy + Math.cos(ang) * 3);
      ctx.lineTo(qx + Math.sin(ang) * 3, qy - Math.cos(ang) * 3);
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${AMBER},0.4)`;
      ctx.stroke();
    }
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = `rgba(${AMBER},0.9)`;
    chevron(ctx, x, y, R + 7, ang + Math.PI, 4.5);
    chevron(ctx, p2.x, p2.y, R + 7, ang, 4.5);
    if (info.zoom) {
      const mx = (x + p2.x) / 2, my = (y + p2.y) / 2;
      const label = `${info.zoom.toFixed(1).replace('.', ',')}×`;
      ctx.font = '600 12px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(label).width + 16;
      ctx.fillStyle = 'rgba(8,14,20,0.8)';
      ctx.beginPath();
      ctx.roundRect?.(mx - w / 2, my - 11, w, 22, 11);
      if (!ctx.roundRect) ctx.rect(mx - w / 2, my - 11, w, 22);
      ctx.fill();
      ctx.strokeStyle = `rgba(${AMBER},0.7)`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = `rgba(${AMBER},1)`;
      ctx.fillText(label, mx, my + 0.5);
    }
  }
}

// Ganchos para testes automatizados
export const _test = { assign, readHand, curls };
