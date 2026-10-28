import * as THREE from 'three';

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

export const scene = new THREE.Scene();

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
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x0a0c10, 0.75));
const key = new THREE.DirectionalLight(0xfff4ea, 2.2);
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

// Plataforma do projetor: anéis finos no chão, sob o modelo
export const platform = new THREE.Group();
const ringMat = (o) => new THREE.MeshBasicMaterial({ color: 0x5cc8ff, transparent: true, opacity: o, depthWrite: false });
[[1.55, 1.57, 0.35], [1.75, 1.76, 0.18], [2.2, 2.205, 0.1]].forEach(([a, b, o]) => {
  const m = new THREE.Mesh(new THREE.RingGeometry(a, b, 128), ringMat(o));
  m.rotation.x = -Math.PI / 2;
  platform.add(m);
});
const disc = new THREE.Mesh(new THREE.CircleGeometry(1.55, 96), new THREE.MeshBasicMaterial({ color: 0x5cc8ff, transparent: true, opacity: 0.04, depthWrite: false }));
disc.rotation.x = -Math.PI / 2;
platform.add(disc);
platform.position.y = 0.01;
scene.add(platform);

// Compatibilidade com o código das mãos (sem grade)
export const grid = new THREE.Group();

// Enquadramento que se adapta à tela (no celular em pé a câmera recua)
export let portrait = false;
export function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  portrait = camera.aspect < 0.9;
  const halfW = portrait ? 2.6 : 4.6; // largura útil que precisa caber
  const dist = Math.max(8.4, halfW / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect) + 1.5);
  setView([0, 2.2 + (dist - 8.4) * 0.12, dist], [0, portrait ? 1.6 : 1.3, 0]);
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
