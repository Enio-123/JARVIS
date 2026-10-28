import * as THREE from 'three';
import { scene } from './stage.js';

// Projetor 3D: transforma o JSON do JARVIS em modelos feitos de formas básicas
const MAX_MODELS = 3;
const yAxis = new THREE.Vector3(0, 1, 0);
const box = new THREE.Box3();
const size = new THREE.Vector3();
const center = new THREE.Vector3();

function geometry(p) {
  const [w, h, d] = p.tam;
  let g;
  switch (p.forma) {
    case 'esfera':
      g = new THREE.SphereGeometry(0.5, 40, 24);
      g.scale(w, h, d);
      break;
    case 'cilindro':
      g = new THREE.CylinderGeometry(0.5, 0.5, 1, 40);
      g.scale(w, h, d);
      break;
    case 'cone':
      g = new THREE.ConeGeometry(0.5, 1, 40);
      g.scale(w, h, d);
      break;
    case 'piramide':
      g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4);
      g.rotateY(Math.PI / 4);
      g.scale(w, h, d);
      break;
    case 'toro': {
      const r = Math.min(h, w * 0.45) / 2;
      const R = Math.max(r * 1.2, w / 2 - r);
      g = new THREE.TorusGeometry(R, r, 20, 64);
      g.rotateX(Math.PI / 2);
      g.scale(1, 1, d / w);
      break;
    }
    case 'capsula': {
      const r = w / 2;
      g = new THREE.CapsuleGeometry(r, Math.max(0, h - w), 10, 24);
      g.scale(1, 1, d / w);
      break;
    }
    default:
      g = new THREE.BoxGeometry(w, h, d);
  }
  return g;
}

function buildPart(p) {
  const color = new THREE.Color(p.cor);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.08,
    emissive: p.brilho ? color : new THREE.Color(0),
    emissiveIntensity: p.brilho ? 0.9 : 0,
  });
  const mesh = new THREE.Mesh(geometry(p), mat);
  mesh.castShadow = !p.brilho;
  mesh.receiveShadow = true;
  mesh.position.set(...p.pos);
  mesh.rotation.set(...p.rot.map(THREE.MathUtils.degToRad));
  mesh.name = p.nome;
  mesh.userData.part = true;
  mesh.userData.spin = p.giro * Math.PI * 2;
  if (p.orbita) {
    const pivot = new THREE.Group();
    pivot.userData.orbit = p.orbita * Math.PI * 2;
    pivot.add(mesh);
    return pivot;
  }
  return mesh;
}

export class Projector {
  constructor() {
    this.models = []; // grupos raiz (são esses que a pinça pega)
    this.leaving = [];
    this.lastTouch = 0;
    this.centerX = 0;
    this.centerY = 1.5;
  }

  // Centro do projetor (muda quando o JARVIS vai para o lado)
  setCenter(x, y) {
    if (x === this.centerX && y === this.centerY) return;
    this.centerX = x;
    this.centerY = y;
    this.layout(false);
  }

  // Lista de peças para a pinça com o dedo médio e para mostrar o nome
  parts() {
    const out = [];
    for (const m of this.models) m.traverse((o) => { if (o.userData.part) out.push(o); });
    return out;
  }

  describe() {
    return this.models.map((m) => `${m.name} (peças: ${m.userData.partNames.slice(0, 20).join(', ')})`).join('; ');
  }

  apply(cena, modelo) {
    if (cena === 'limpar') return this.clear();
    if (!modelo || (cena !== 'nova' && cena !== 'adicionar')) return;
    if (cena === 'nova') this.clear();
    while (this.models.length >= MAX_MODELS) this.remove(this.models[0]);
    this.models.push(this.build(modelo));
    this.layout();
  }

  build(modelo) {
    const inner = new THREE.Group();
    for (const p of modelo.partes) inner.add(buildPart(p));
    inner.updateMatrixWorld(true);
    box.setFromObject(inner);
    box.getSize(size);
    box.getCenter(center);
    inner.position.copy(center).negate();
    const root = new THREE.Group();
    root.name = modelo.nome;
    root.add(inner);
    root.userData = {
      extent: Math.max(size.x, size.y, size.z, 0.001),
      height: size.y,
      appear: 0,
      home: true,
      partNames: modelo.partes.map((p) => p.nome),
      vel: null,
    };
    root.scale.setScalar(0.001);
    scene.add(root);
    return root;
  }

  // Distribui os modelos lado a lado e define o tamanho de cada um
  layout(resetHome = true) {
    const n = this.models.length;
    const fit = n === 1 ? 2.8 : n === 2 ? 2.3 : 1.9;
    const gap = n === 2 ? 3 : 3.3;
    this.models.forEach((m, i) => {
      const s = fit / m.userData.extent;
      m.userData.base = s;
      m.userData.target = new THREE.Vector3(this.centerX + (i - (n - 1) / 2) * gap, Math.max(this.centerY, (m.userData.height * s) / 2 + 0.3), 0);
      if (resetHome) m.userData.home = true;
      if (m.userData.appear === 0) m.position.copy(m.userData.target);
      else if (m.userData.appear >= 1 && resetHome) m.scale.setScalar(s);
    });
  }

  remove(m) {
    this.models = this.models.filter((x) => x !== m);
    m.userData.leave = 1;
    m.userData.leaveScale = m.scale.x;
    this.leaving.push(m);
    this.onRemove?.(m);
  }

  clear() {
    for (const m of [...this.models]) this.remove(m);
  }

  touched() {
    this.lastTouch = performance.now();
  }

  update(dt) {
    const idle = performance.now() - this.lastTouch > 3500;
    for (const m of this.models) {
      const u = m.userData;
      if (u.appear < 1) {
        u.appear = Math.min(1, u.appear + dt / 0.55);
        const e = 1 - Math.pow(1 - u.appear, 3);
        m.scale.setScalar(u.base * Math.max(0.001, e));
      }
      if (u.held) {
        u.home = false;
      } else {
        if (u.home && u.target) m.position.lerp(u.target, 1 - Math.exp(-dt * 4));
        // gira devagar quando ninguém está mexendo, para mostrar que é 3D
        if (idle) m.rotateOnWorldAxis(yAxis, dt * 0.18);
      }
      m.traverse((o) => {
        if (o.userData.orbit) o.rotation.y += o.userData.orbit * dt;
        if (o.userData.spin && !o.userData.held) o.rotateY(o.userData.spin * dt);
      });
    }
    for (const m of [...this.leaving]) {
      m.userData.leave -= dt / 0.3;
      if (m.userData.leave <= 0) {
        scene.remove(m);
        m.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
        this.leaving = this.leaving.filter((x) => x !== m);
      } else {
        m.scale.setScalar(m.userData.leaveScale * Math.max(0.001, m.userData.leave));
      }
    }
  }
}
