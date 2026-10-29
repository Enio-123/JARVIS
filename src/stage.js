import * as THREE from 'three';
import { RoomEnvironment } from '../vendor/three-addons/RoomEnvironment.js';

// ---------- Renderizador, cena e câmera ----------
export const canvas = document.getElementById('scene');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.setClearColor(0x000000, 0); // o fundo é o gradiente do CSS
renderer.localClippingEnabled = true; // usado no efeito de montagem do holograma

export const scene = new THREE.Scene();
// Reflexos suaves de um "estúdio" para os materiais brilhantes e metálicos
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
pmrem.dispose();

export const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
camera.position.set(0, 2.2, 8.4);
const look = new THREE.Vector3(0, 1.3, 0);
camera.lookAt(look);
const viewPos = camera.position.clone();
const viewLook = look.clone();

// Muda o enquadramento da câmera com transição suave
export function setView(pos, target, instant = false) {
  viewPos.set(...pos);
  viewLook.set(...target);
  if (instant) {
    camera.position.copy(viewPos);
    look.copy(viewLook);
    camera.lookAt(look);
  }
}

// Luz principal quente, preenchimento frio e luz de contorno azul por trás
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x0a0c10, 0.45));
const key = new THREE.DirectionalLight(0xfff4ea, 1.8);
key.position.set(3.5, 8, 6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 30 });
key.shadow.bias = -0.0004;
key.shadow.radius = 6;
scene.add(key);
const rim = new THREE.DirectionalLight(0x5cc8ff, 1.6);
rim.position.set(-5, 4, -6);
scene.add(rim);

// Chão invisível que só recebe sombra (sem linha de horizonte)
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.35 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// Textura de HUD desenhada no próprio código: anéis, marcações e arcos no estilo das telas do Stark
export function hudTexture(kind = 'platform') {
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.translate(S / 2, S / 2);
  g.strokeStyle = '#5cd0ff';
  const R = S / 2 - 8;
  const ring = (r, w, a, dash = []) => {
    g.globalAlpha = a; g.lineWidth = w; g.setLineDash(dash);
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
  };
  const arc = (r, w, a, from, to) => {
    g.globalAlpha = a; g.lineWidth = w; g.setLineDash([]);
    g.beginPath(); g.arc(0, 0, r, from, to); g.stroke();
  };
  const ticks = (r, len, n, w, a, every = 0, longLen = 0) => {
    g.globalAlpha = a; g.lineWidth = w; g.setLineDash([]);
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const l = every && i % every === 0 ? longLen : len;
      g.moveTo(Math.cos(ang) * r, Math.sin(ang) * r);
      g.lineTo(Math.cos(ang) * (r - l), Math.sin(ang) * (r - l));
    }
    g.stroke();
  };
  if (kind === 'platform') {
    ring(R, 3, 0.6);
    ticks(R - 14, 10, 120, 2, 0.45, 10, 24);
    arc(R - 54, 9, 0.55, 0.2, 1.3);
    arc(R - 54, 9, 0.55, 2.3, 3.1);
    arc(R - 54, 9, 0.55, 4.1, 5.6);
    ring(R - 82, 2, 0.32, [14, 10]);
    ring(R * 0.6, 2, 0.28);
    ticks(R * 0.6, 9, 72, 2, 0.32);
  } else {
    ring(R, 3, 0.55);
    ticks(R - 12, 12, 90, 2.5, 0.5, 15, 28);
    arc(R - 50, 10, 0.6, -0.6, 0.6);
    arc(R - 50, 10, 0.6, Math.PI - 0.6, Math.PI + 0.6);
    ring(R - 76, 2, 0.3, [10, 12]);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function glowTexture(rgba = '92,208,255') {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, `rgba(${rgba},1)`);
  grd.addColorStop(0.5, `rgba(${rgba},0.35)`);
  grd.addColorStop(1, `rgba(${rgba},0)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Plataforma do projetor: anéis de HUD no chão, sob o modelo
export const platform = new THREE.Group();
const platMat = new THREE.MeshBasicMaterial({ map: hudTexture('platform'), transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
const platRing = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 4.5), platMat);
platRing.rotation.x = -Math.PI / 2;
platform.add(platRing);
const discMat = new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
const disc = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), discMat);
disc.rotation.x = -Math.PI / 2;
disc.position.y = -0.002;
platform.add(disc);
platform.position.y = 0.01;
platform.userData = { ring: platRing, ringMat: platMat, discMat };
scene.add(platform);

// Compatibilidade com o código das mãos (sem grade)
export const grid = new THREE.Group();

// Enquadramento que se adapta à tela (no celular em pé a câmera recua).
// "lift" move o ponto de mira: negativo faz o palco subir na tela (tela de início),
// positivo faz descer (celular com o cartão de música no topo).
export let portrait = false;
let lift = 0;
export function setLift(v) {
  v = Math.round(v * 50) / 50;
  if (v === lift) return;
  lift = v;
  resize();
}

// Quanto subir o ponto de mira para que um ponto na altura y (em z = 0) apareça abaixo da linha screenY
export function liftFor(y, screenY) {
  const k = innerHeight / 2 / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * viewPos.z);
  return Math.max(0, y - (portrait ? 1.6 : 1.3) - (innerHeight / 2 - screenY) / k);
}
export function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  portrait = camera.aspect < 0.9;
  const halfW = portrait ? 2.6 : 4.6; // largura útil que precisa caber
  const dist = Math.max(8.4, halfW / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect) + 1.5);
  setView([0, 2.2 + (dist - 8.4) * 0.12, dist], [0, (portrait ? 1.6 : 1.3) + lift, 0]);
  camera.updateProjectionMatrix();
}

export function updateCamera(dt) {
  const k = 1 - Math.exp(-dt * 5);
  camera.position.lerp(viewPos, k);
  look.lerp(viewLook, k);
  camera.lookAt(look);
}

// ---------- Projeção tela <-> mundo ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const forward = new THREE.Vector3();
const tmp = new THREE.Vector3();

export function setRay(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster;
}

export function raycast(x, y, list, recursive = false) {
  return setRay(x, y).intersectObjects(list, recursive)[0] || null;
}

export function viewDirection(out = forward) {
  return camera.getWorldDirection(out);
}

// Profundidade de um ponto medida ao longo da direção da câmera
export function depthOf(point) {
  viewDirection();
  return tmp.copy(point).sub(camera.position).dot(forward);
}

// Ponto do mundo sob o pixel (x, y) a uma profundidade d
export function pointAt(x, y, d, out = new THREE.Vector3()) {
  setRay(x, y);
  viewDirection();
  const dir = raycaster.ray.direction;
  return out.copy(camera.position).addScaledVector(dir, d / dir.dot(forward));
}

// Ponto do mundo sob o pixel (x, y) no plano horizontal de altura h
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
export function pointOnPlaneY(x, y, h, out = new THREE.Vector3()) {
  setRay(x, y);
  plane.constant = -h;
  return raycaster.ray.intersectPlane(plane, out);
}

// Pixel da tela de um ponto do mundo
export function toScreen(p) {
  tmp.copy(p).project(camera);
  return { x: (tmp.x + 1) / 2 * innerWidth, y: (1 - tmp.y) / 2 * innerHeight, behind: tmp.z > 1 };
}

// Raio em pixels de uma esfera de raio r no ponto p
export function screenRadius(p, r) {
  const d = Math.max(0.1, depthOf(p));
  return (r / (d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) * (innerHeight / 2);
}

export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------- Física simples ----------
export const BOUNDS = { x: 5.5, zMin: -4.5, zMax: 3, yMax: 7 };
const box = new THREE.Box3();
const GRAVITY = 14;

export function keepAboveFloor(o) {
  box.setFromObject(o, true);
  if (box.min.y < 0) {
    o.position.y -= box.min.y;
    return true;
  }
  return false;
}

export function clampToBounds(o, v) {
  const p = o.position;
  if (p.x < -BOUNDS.x) { p.x = -BOUNDS.x; if (v) v.x = Math.abs(v.x) * 0.5; }
  if (p.x > BOUNDS.x) { p.x = BOUNDS.x; if (v) v.x = -Math.abs(v.x) * 0.5; }
  if (p.z < BOUNDS.zMin) { p.z = BOUNDS.zMin; if (v) v.z = Math.abs(v.z) * 0.5; }
  if (p.z > BOUNDS.zMax) { p.z = BOUNDS.zMax; if (v) v.z = -Math.abs(v.z) * 0.5; }
  if (p.y > BOUNDS.yMax) { p.y = BOUNDS.yMax; if (v && v.y > 0) v.y = 0; }
}

export function physics(o, dt) {
  const v = o.userData.vel;
  v.y -= GRAVITY * dt;
  o.position.addScaledVector(v, dt);
  if (keepAboveFloor(o)) {
    v.y = v.y < -1 ? -v.y * 0.35 : 0;
    const friction = Math.max(0, 1 - 5 * dt);
    v.x *= friction;
    v.z *= friction;
  }
  clampToBounds(o, v);
}
