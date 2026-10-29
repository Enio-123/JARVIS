import * as THREE from 'three';
import { scene, camera, hudTexture } from './stage.js';

// O JARVIS em pessoa: um robozinho flutuante feito no próprio código.
// - rosto numa tela curva, com olhos que mudam de expressão e uma boca que acompanha a voz
// - reator arc no peito (homenagem ao Tony Stark) e um repulsor embaixo, que o mantém flutuando
// - gestos: acena ao acordar, aponta para o holograma que acabou de criar, coça o queixo pensando
//   e dança no ritmo quando uma música está tocando
const CYAN = '#5cd0ff';
const ACCENT = new THREE.Color(CYAN);
const RED = new THREE.Color('#ff5a4f');

const shell = new THREE.MeshPhysicalMaterial({ color: 0xf4f6f9, roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.15, envMapIntensity: 0.9 });
const trim = new THREE.MeshPhysicalMaterial({ color: 0x8e97a4, roughness: 0.32, metalness: 0.85, envMapIntensity: 1 });
const dark = new THREE.MeshPhysicalMaterial({ color: 0x1a1e24, roughness: 0.4, metalness: 0.6 });
const glowMat = () => new THREE.MeshBasicMaterial({ color: ACCENT.clone(), toneMapped: false });

function mesh(geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = false; // a sombra do robô é a mancha suave no chão
  return m;
}

function radialTexture(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  stops.forEach(([o, col]) => grd.addColorStop(o, col));
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------- Tela do rosto ----------
// Uma grade de vértices "dobrada" sobre o elipsoide da cabeça, com cantos arredondados (alphaMap)
const HEAD = { a: 0.59, b: 0.45, c: 0.5 };
const FACE = { w: 0.86, h: 0.5, y: -0.02 };
const FW = 512, FH = 298;

function faceGeometry() {
  const g = new THREE.PlaneGeometry(FACE.w, FACE.h, 48, 28);
  const p = g.attributes.position;
  const n = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i) + FACE.y;
    const inside = Math.max(0.02, 1 - (x / HEAD.a) ** 2 - (y / HEAD.b) ** 2);
    const z = HEAD.c * Math.sqrt(inside);
    n.set(x / HEAD.a ** 2, y / HEAD.b ** 2, z / HEAD.c ** 2).normalize();
    p.setXYZ(i, x + n.x * 0.006, y + n.y * 0.006, z + n.z * 0.006);
  }
  g.computeVertexNormals();
  return g;
}

function roundedRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function faceAlpha() {
  const c = document.createElement('canvas');
  c.width = FW;
  c.height = FH;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, FW, FH);
  g.fillStyle = '#fff';
  roundedRect(g, 6, 6, FW - 12, FH - 12, 118);
  g.fill();
  return new THREE.CanvasTexture(c);
}

// ---------- Reator arc ----------
function reactorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 256);
  g.translate(128, 128);
  g.shadowColor = CYAN;
  g.shadowBlur = 18;
  g.strokeStyle = '#bfefff';
  g.lineWidth = 8;
  g.beginPath();
  g.arc(0, 0, 104, 0, Math.PI * 2);
  g.stroke();
  // bobinas ao redor
  g.fillStyle = '#7fdcff';
  for (let i = 0; i < 10; i++) {
    g.save();
    g.rotate((i / 10) * Math.PI * 2);
    roundedRect(g, -11, -92, 22, 34, 5);
    g.fill();
    g.restore();
  }
  g.lineWidth = 5;
  g.beginPath();
  g.arc(0, 0, 50, 0, Math.PI * 2);
  g.stroke();
  // núcleo
  const core = g.createRadialGradient(0, 0, 0, 0, 0, 44);
  core.addColorStop(0, '#ffffff');
  core.addColorStop(0.45, '#c8f2ff');
  core.addColorStop(1, 'rgba(92,208,255,0)');
  g.fillStyle = core;
  g.beginPath();
  g.arc(0, 0, 44, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const lerp = (a, b, k) => a + (b - a) * k;

export class Character {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'JARVIS';
    this.t = 0;
    this.level = 0;
    this.home = new THREE.Vector3();
    this.targetScale = 1;
    this.blink = 0;
    this.nextBlink = 2.5;
    this.wave = 0;
    this.presentT = 0;
    this.presentDir = new THREE.Vector3(1, 0, 0);
    this.happyT = 0;
    this.errorT = 0;
    this.spinT = 0;
    this.wakeT = 0;
    this.pet = false;
    this.beat = null; // { bpm, time } quando há música tocando
    this.face = { lx: 0, ly: 0, eye: { w: 50, h: 100, r: 25 }, mood: 'off', lastDraw: 0 };

    this.float = new THREE.Group();
    this.root.add(this.float);

    // corpo
    const body = mesh(new THREE.SphereGeometry(0.42, 64, 40), shell);
    body.scale.set(1, 1.08, 0.92);
    body.position.y = 0.62;
    this.float.add(body);
    const belt = mesh(new THREE.TorusGeometry(0.405, 0.012, 12, 96), dark);
    belt.rotation.x = Math.PI / 2;
    belt.scale.set(1, 0.92, 1);
    belt.position.y = 0.5;
    this.float.add(belt);

    // reator arc no peito
    this.reactorMat = new THREE.MeshBasicMaterial({ map: reactorTexture(), toneMapped: false, color: 0xffffff });
    const reactor = mesh(new THREE.CircleGeometry(0.115, 48), this.reactorMat);
    reactor.position.set(0, 0.7, 0.392);
    reactor.rotation.x = -0.14;
    this.float.add(reactor);
    const bezel = mesh(new THREE.TorusGeometry(0.122, 0.018, 16, 64), trim);
    bezel.position.copy(reactor.position);
    bezel.rotation.x = -0.14;
    this.float.add(bezel);

    // repulsor embaixo
    this.thrusterMat = glowMat();
    const thruster = mesh(new THREE.CircleGeometry(0.075, 32), this.thrusterMat);
    thruster.rotation.x = Math.PI / 2;
    thruster.position.y = 0.17;
    this.float.add(thruster);
    const ring = mesh(new THREE.TorusGeometry(0.085, 0.014, 12, 40), trim);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.175;
    this.float.add(ring);
    const flameTex = radialTexture([[0, 'rgba(180,235,255,0.9)'], [0.35, 'rgba(92,208,255,0.35)'], [1, 'rgba(92,208,255,0)']]);
    this.flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.flame.scale.set(0.34, 0.5, 1);
    this.flame.position.y = 0.04;
    this.float.add(this.flame);

    const neck = mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.12, 32), trim);
    neck.position.y = 1.08;
    this.float.add(neck);

    // cabeça
    this.head = new THREE.Group();
    this.head.position.y = 1.5;
    this.float.add(this.head);
    const skull = mesh(new THREE.SphereGeometry(0.5, 72, 48), shell);
    skull.scale.set(HEAD.a / 0.5, HEAD.b / 0.5, 1);
    this.head.add(skull);

    this.faceCanvas = document.createElement('canvas');
    this.faceCanvas.width = FW;
    this.faceCanvas.height = FH;
    this.faceCtx = this.faceCanvas.getContext('2d');
    this.faceTex = new THREE.CanvasTexture(this.faceCanvas);
    this.faceTex.colorSpace = THREE.SRGBColorSpace;
    const screen = mesh(faceGeometry(), new THREE.MeshPhysicalMaterial({
      color: 0x040507, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04,
      emissive: 0xffffff, emissiveMap: this.faceTex, emissiveIntensity: 1.5,
      alphaMap: faceAlpha(), alphaTest: 0.5, alphaToCoverage: true, envMapIntensity: 1.2,
    }));
    this.head.add(screen);

    // "orelhas" com anel de luz
    this.earRings = [-1, 1].map((s) => {
      const ear = mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.1, 48), trim);
      ear.rotation.z = Math.PI / 2;
      ear.position.set(s * 0.585, 0, 0);
      this.head.add(ear);
      const cap = mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.02, 40), dark);
      cap.rotation.z = Math.PI / 2;
      cap.position.set(s * 0.64, 0, 0);
      this.head.add(cap);
      const r = mesh(new THREE.TorusGeometry(0.075, 0.012, 12, 40), glowMat());
      r.rotation.y = Math.PI / 2;
      r.position.set(s * 0.652, 0, 0);
      this.head.add(r);
      return r;
    });

    // antena
    const stem = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 12), trim);
    stem.position.set(0.12, 0.52, 0);
    stem.rotation.z = -0.2;
    this.head.add(stem);
    this.tip = mesh(new THREE.SphereGeometry(0.045, 24, 16), glowMat());
    this.tip.position.set(0.145, 0.63, 0);
    this.head.add(this.tip);

    // mãozinhas soltas
    this.hands = [-1, 1].map((s) => {
      const h = mesh(new THREE.SphereGeometry(0.13, 40, 28), shell);
      h.scale.set(0.9, 1.1, 0.9);
      h.position.set(s * 0.6, 0.55, 0.05);
      this.float.add(h);
      return h;
    });

    // sombra suave e luz do repulsor no chão
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), new THREE.MeshBasicMaterial({
      map: radialTexture([[0, 'rgba(0,0,0,0.6)'], [1, 'rgba(0,0,0,0)']]), transparent: true, depthWrite: false,
    }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.011;
    this.root.add(this.shadow);
    this.pool = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.MeshBasicMaterial({
      map: radialTexture([[0, 'rgba(92,208,255,0.55)'], [1, 'rgba(92,208,255,0)']]),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.pool.rotation.x = -Math.PI / 2;
    this.pool.position.y = 0.013;
    this.root.add(this.pool);
    // anel de HUD no chão, que gira mais rápido quando ele pensa
    this.ringMat = new THREE.MeshBasicMaterial({
      map: hudTexture('robot'), transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 2.1), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.012;
    this.root.add(this.ring);

    scene.add(this.root);
    this._meshes = [];
    this.root.traverse((o) => { if (o.isMesh && o !== this.shadow && o !== this.pool && o !== this.ring) this._meshes.push(o); });
  }

  meshes() {
    return this._meshes;
  }

  // ---------- Gatilhos de gestos ----------
  greet() { this.wave = 1.8; this.happyT = 1.6; }
  wake() { this.wakeT = 1.2; }
  happy(s = 1.4) { this.happyT = Math.max(this.happyT, s); }
  error() { this.errorT = 1.6; }
  spin() { if (this.spinT <= 0) { this.spinT = 1; this.happyT = 1.4; } }
  present(worldPos) {
    this.presentT = 1.8;
    this.presentDir.copy(worldPos);
  }

  setPlace(x, z, scale) {
    this.home.set(x, 0, z);
    this.targetScale = scale;
  }

  // ---------- Rosto ----------
  drawFace(state, dt) {
    const f = this.face;
    const g = this.faceCtx;
    const t = this.t;
    let mood = state === 'off' ? 'off' : state === 'paused' ? 'sleepy' : state;
    if (this.wakeT > 0) mood = 'boot';
    if (this.errorT > 0) mood = 'error';
    else if (this.happyT > 0 || this.pet || (this.beat && state !== 'speaking' && state !== 'thinking')) mood = state === 'off' ? mood : 'happy';

    // tamanho dos olhos interpolado (piscar, ouvir, sonolento)
    const blinkK = this.blink > 0 ? Math.abs(Math.sin((this.blink / 0.16) * Math.PI)) : 0;
    const base = { w: 50, h: 100, r: 25 };
    if (mood === 'hearing') base.h = 112 + Math.min(1, this.level * 14) * 10;
    if (mood === 'sleepy') base.h = 30;
    if (mood === 'speaking') base.h = 92;
    f.eye.w = lerp(f.eye.w, base.w, Math.min(1, dt * 12));
    f.eye.h = lerp(f.eye.h, base.h * (1 - blinkK * 0.9), Math.min(1, dt * (blinkK ? 40 : 12)));

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, FW, FH);
    const cx = FW / 2, cy = 128;
    const lx = f.lx, ly = f.ly;
    const col = mood === 'error' ? '#ff5a4f' : CYAN;
    g.shadowColor = col;
    g.shadowBlur = 26;
    g.fillStyle = col;
    g.strokeStyle = col;
    g.lineCap = 'round';

    const eyes = [-1, 1].map((s) => ({ x: cx + s * 92 + lx, y: cy + ly }));
    if (mood === 'off') {
      g.globalAlpha = 0.45;
      g.lineWidth = 12;
      for (const e of eyes) { g.beginPath(); g.moveTo(e.x - 26, e.y + 10); g.lineTo(e.x + 26, e.y + 10); g.stroke(); }
      g.globalAlpha = 1;
    } else if (mood === 'boot') {
      // liga com um leve tremor, como uma tela acendendo
      const k = 1 - this.wakeT / 1.2;
      g.globalAlpha = Math.min(1, k * 1.6) * (0.7 + 0.3 * Math.sin(t * 60));
      for (const e of eyes) { roundedRect(g, e.x - 25, e.y - 50 * k, 50, Math.max(8, 100 * k), 25); g.fill(); }
      g.globalAlpha = 1;
    } else if (mood === 'happy') {
      g.lineWidth = 16;
      for (const e of eyes) { g.beginPath(); g.arc(e.x, e.y + 26, 34, Math.PI * 1.15, Math.PI * 1.85); g.stroke(); }
    } else if (mood === 'error') {
      // olhos tristes inclinados
      eyes.forEach((e, i) => {
        g.save();
        g.translate(e.x, e.y + 10);
        g.rotate(i ? -0.35 : 0.35);
        roundedRect(g, -25, -22, 50, 44, 20);
        g.fill();
        g.restore();
      });
    } else {
      const look = mood === 'thinking' ? { x: 16 + Math.sin(t * 2.2) * 10, y: -16 } : { x: 0, y: 0 };
      for (const e of eyes) {
        roundedRect(g, e.x - f.eye.w / 2 + look.x, e.y - f.eye.h / 2 + look.y, f.eye.w, f.eye.h, f.eye.r);
        g.fill();
      }
    }

    // boca: equalizador quando fala, reticências quando pensa
    const my = 236 + ly * 0.5;
    if (mood === 'speaking') {
      const lv = Math.min(1, this.level * 2.4);
      for (let i = 0; i < 5; i++) {
        const ph = Math.sin(t * 17 + i * 1.7) * 0.5 + 0.5;
        const h = 8 + lv * (14 + 26 * ph) * (i === 2 ? 1 : i === 1 || i === 3 ? 0.8 : 0.55);
        roundedRect(g, cx + lx * 0.6 + (i - 2) * 18 - 5, my - h / 2, 10, h, 5);
        g.fill();
      }
    } else if (mood === 'thinking') {
      for (let i = 0; i < 3; i++) {
        const a = 0.35 + 0.65 * Math.max(0, Math.sin(t * 6 - i * 0.9));
        g.globalAlpha = a;
        g.beginPath();
        g.arc(cx + (i - 1) * 24, my, 7, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    }
    this.faceTex.needsUpdate = true;
  }

  // ---------- Animação ----------
  update(dt, state, level, target) {
    this.t += dt;
    const t = this.t;
    this.level += (level - this.level) * Math.min(1, dt * 16);
    const k = 1 - Math.exp(-dt * 3);
    for (const key of ['wave', 'presentT', 'happyT', 'errorT', 'wakeT']) this[key] = Math.max(0, this[key] - dt);

    // posição e tamanho
    this.root.position.lerp(this.home, k);
    const s = this.root.scale.x + (this.targetScale - this.root.scale.x) * k;
    this.root.scale.setScalar(s);

    // ritmo da música
    let beatPh = 0, dancing = false;
    if (this.beat && state !== 'speaking' && state !== 'off') {
      dancing = true;
      beatPh = this.beat.time * (this.beat.bpm / 60) * Math.PI * 2;
    }

    // flutuar (e dançar)
    const bob = Math.sin(t * 1.6) * 0.06 + (dancing ? Math.abs(Math.sin(beatPh / 2)) * 0.05 : 0);
    this.float.position.y = 0.35 + bob;
    this.float.rotation.z = lerp(this.float.rotation.z, dancing ? Math.sin(beatPh / 2) * 0.07 : 0, k * 2);
    this.shadow.scale.setScalar(1 - bob * 1.5);
    this.pool.scale.setScalar(0.9 - bob);
    const on = state !== 'off';
    const thrust = on ? 0.75 + Math.sin(t * 1.6 + Math.PI) * 0.15 + (state === 'speaking' ? this.level * 0.5 : 0) : 0.15;
    this.flame.material.opacity = thrust;
    this.flame.scale.set(0.32, 0.42 + thrust * 0.16, 1);
    this.pool.material.opacity = thrust * 0.8;
    this.thrusterMat.color.copy(ACCENT).multiplyScalar(0.4 + thrust * 0.8);

    // giro de alegria (quando a pessoa "faz carinho" com a pinça)
    if (this.spinT > 0) {
      this.spinT = Math.max(0, this.spinT - dt / 0.9);
      const e = 1 - this.spinT;
      this.float.rotation.y = (1 - Math.pow(1 - e, 3)) * Math.PI * 2;
      if (this.spinT === 0) this.float.rotation.y = 0;
    }

    // olhar: corpo e cabeça viram para o alvo (mão, mouse, holograma ou a câmera)
    const look = target || camera.position;
    const local = this.root.worldToLocal(look.clone());
    const yaw = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -1.1, 1.1);
    const pitch = THREE.MathUtils.clamp(-Math.atan2(local.y - 1.85, Math.hypot(local.x, local.z)), -0.45, 0.35);
    if (this.spinT === 0) this.float.rotation.y += (yaw * 0.35 - this.float.rotation.y) * k;
    let tilt = 0;
    if (state === 'listening') tilt = 0.12;
    if (state === 'hearing') tilt = 0.2;
    if (state === 'thinking') tilt = -0.08;
    if (this.pet) tilt = 0.18 + Math.sin(t * 8) * 0.06;
    const nod = state === 'speaking' ? Math.sin(t * 7) * 0.035 * Math.min(1, this.level * 3) : 0;
    const groove = dancing ? Math.sin(beatPh) * 0.09 : 0;
    const asleep = state === 'off' ? 0.38 : state === 'paused' ? 0.18 : 0;
    this.head.rotation.y += (yaw * 0.65 - this.head.rotation.y) * k * 1.5;
    this.head.rotation.x += (pitch * 0.7 + nod + groove + asleep - this.head.rotation.x) * k * (dancing ? 6 : 1.5);
    this.head.rotation.z += (tilt - this.head.rotation.z) * k;

    // os olhos seguem o alvo dentro da tela
    const eyeX = THREE.MathUtils.clamp((yaw - this.head.rotation.y - this.float.rotation.y) * 70, -28, 28);
    const eyeY = THREE.MathUtils.clamp((pitch - this.head.rotation.x) * -60, -18, 18);
    this.face.lx = lerp(this.face.lx, on ? eyeX : 0, Math.min(1, dt * 8));
    this.face.ly = lerp(this.face.ly, on ? eyeY : 0, Math.min(1, dt * 8));

    // piscar
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && on) { this.blink = 0.16; this.nextBlink = 2.2 + Math.random() * 3.8; }
    this.blink = Math.max(0, this.blink - dt);

    // desenha o rosto no máximo a 40 quadros por segundo
    if (t - this.face.lastDraw > 1 / 40) {
      this.drawFace(state, t - this.face.lastDraw);
      this.face.lastDraw = t;
    }

    // luzes: antena, orelhas e reator acompanham o estado
    const speakK = state === 'speaking' ? Math.min(1, this.level * 2.2) : 0;
    const pulse = !on ? 0.2
      : state === 'thinking' ? 0.6 + 0.4 * Math.sin(t * 9)
      : state === 'hearing' ? 1.3
      : state === 'speaking' ? 0.8 + speakK * 0.8
      : state === 'paused' ? 0.35
      : 0.85 + 0.15 * Math.sin(t * 2);
    const tint = this.errorT > 0 ? RED : ACCENT;
    this.tip.material.color.copy(tint).multiplyScalar(pulse);
    this.earRings.forEach((r) => r.material.color.copy(tint).multiplyScalar(on ? 0.5 + speakK * 0.7 + (state === 'hearing' ? 0.5 : 0) : 0.15));
    const reactor = !on ? 0.25 : 0.75 + speakK * 0.55 + (state === 'thinking' ? 0.2 * Math.sin(t * 9) : 0.08 * Math.sin(t * 2));
    this.reactorMat.color.setScalar(reactor);
    this.ring.rotation.z += dt * (state === 'thinking' ? 1.4 : dancing ? 0.6 : 0.16);
    const ringA = !on ? 0.06
      : state === 'thinking' ? 0.5 + 0.15 * Math.sin(t * 9)
      : state === 'hearing' ? 0.65
      : state === 'speaking' ? 0.35 + speakK * 0.35
      : 0.3;
    this.ringMat.opacity += (ringA - this.ringMat.opacity) * Math.min(1, dt * 6);

    // mãos: acenar, apresentar o holograma, pensar ou dançar
    const rel = this.presentT > 0 ? this.root.worldToLocal(this.presentDir.clone()) : null;
    this.hands.forEach((h, i) => {
      const side = i ? 1 : -1;
      const sway = Math.sin(t * 1.6 + i * 1.3) * 0.04;
      let x = side * 0.6, y = 0.55 + sway, z = 0.05;
      if (dancing) {
        y = 0.62 + Math.sin(beatPh + i * Math.PI) * 0.09;
        z = 0.12;
      }
      if (i === 1 && this.wave > 0) {
        y = 1.08 + Math.sin(this.wave * 3) * 0.05;
        x = 0.74 + Math.sin(this.wave * 14) * 0.08;
        z = 0.15;
      } else if (rel && (rel.x >= 0 ? i === 1 : i === 0)) {
        // estende a mão na direção do holograma
        const d = new THREE.Vector3(rel.x, 0, rel.z).normalize();
        x = side * 0.5 + d.x * 0.32;
        y = 0.95;
        z = 0.12 + d.z * 0.3;
      } else if (state === 'thinking' && i === 0) {
        x = -0.24; y = 1.06; z = 0.4; // mão no queixo
      } else if (state === 'speaking') {
        y += Math.sin(t * 3 + i * 2) * 0.05 * Math.min(1, this.level * 3);
      }
      const kk = Math.min(1, k * 2.8);
      h.position.x += (x - h.position.x) * kk;
      h.position.y += (y - h.position.y) * kk;
      h.position.z += (z - h.position.z) * kk;
    });
  }
}
