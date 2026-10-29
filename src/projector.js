import * as THREE from 'three';
import { RoundedBoxGeometry } from '../vendor/three-addons/RoundedBoxGeometry.js';
import { scene } from './stage.js';

// Projetor holográfico: transforma o JSON do JARVIS em modelos feitos de formas básicas.
// Cada modelo "se imprime" de baixo para cima (plano de corte + anel de varredura + fantasma em
// arame), pode ser destacado peça por peça enquanto ele fala, explodido em vista separada,
// e jogado para longe com a mão para sumir.
const MAX_MODELS = 3;
const BUILD_TIME = 1.25;
const ACCENT = new THREE.Color(0x5cd0ff);
const yAxis = new THREE.Vector3(0, 1, 0);
const box = new THREE.Box3();
const size = new THREE.Vector3();
const center = new THREE.Vector3();
const tmp = new THREE.Vector3();

export const normalize = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Ajusta qualquer geometria para caber exatamente num cubo 1x1x1 centrado
function fitUnit(g) {
  g.computeBoundingBox();
  const b = g.boundingBox;
  const s = new THREE.Vector3();
  b.getSize(s);
  const c = new THREE.Vector3();
  b.getCenter(c);
  g.translate(-c.x, -c.y, -c.z);
  g.scale(1 / (s.x || 1), 1 / (s.y || 1), 1 / (s.z || 1));
  return g;
}

function geometry(p) {
  const [w, h, d] = p.tam;
  let g;
  switch (p.forma) {
    case 'esfera':
      g = new THREE.SphereGeometry(0.5, 48, 32);
      break;
    case 'semiesfera':
      g = fitUnit(new THREE.SphereGeometry(0.5, 48, 18, 0, Math.PI * 2, 0, Math.PI / 2));
      break;
    case 'cilindro':
      g = new THREE.CylinderGeometry(0.5 * THREE.MathUtils.clamp(p.topo ?? 1, 0, 1), 0.5, 1, 48);
      break;
    case 'cone':
      g = new THREE.ConeGeometry(0.5, 1, 48);
      break;
    case 'piramide':
      g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4);
      g.rotateY(Math.PI / 4);
      g = fitUnit(g);
      break;
    case 'prisma':
      g = fitUnit(new THREE.CylinderGeometry(0.5, 0.5, 1, 3));
      break;
    case 'tubo': {
      const r = 0.5, ri = r * (1 - THREE.MathUtils.clamp(p.espessura ?? 0.25, 0.05, 0.95));
      g = new THREE.LatheGeometry([
        new THREE.Vector2(ri, -0.5), new THREE.Vector2(r, -0.5), new THREE.Vector2(r, 0.5),
        new THREE.Vector2(ri, 0.5), new THREE.Vector2(ri, -0.5),
      ], 48);
      break;
    }
    case 'toro': {
      const r = Math.min(h, w * 0.45) / 2;
      const R = Math.max(r * 1.2, w / 2 - r);
      g = new THREE.TorusGeometry(R, r, 24, 72);
      g.rotateX(Math.PI / 2);
      g.scale(1, 1, d / w);
      return g;
    }
    case 'capsula': {
      const r = w / 2;
      g = new THREE.CapsuleGeometry(r, Math.max(0, h - w), 12, 32);
      g.scale(1, 1, d / w);
      return g;
    }
    default: {
      const r = Math.min(0.12, Math.min(w, h, d) * 0.12);
      return new RoundedBoxGeometry(w, h, d, 3, r);
    }
  }
  g.scale(w, h, d);
  return g;
}

function material(p) {
  const color = new THREE.Color(p.cor);
  const side = p.forma === 'semiesfera' || p.forma === 'tubo' ? THREE.DoubleSide : THREE.FrontSide;
  switch (p.material) {
    case 'metal':
      return new THREE.MeshStandardMaterial({ color, metalness: 0.9, roughness: 0.28, side });
    case 'vidro':
      return new THREE.MeshPhysicalMaterial({ color, roughness: 0.04, metalness: 0, clearcoat: 1, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide });
    case 'luz':
      return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5, roughness: 0.4, side });
    case 'fosco':
      return new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0, side });
    default:
      return new THREE.MeshPhysicalMaterial({ color, roughness: 0.4, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.3, side });
  }
}

function buildPart(p, clipSolid, clipWire, wireMat) {
  const geo = geometry(p);
  const mat = material(p);
  mat.clippingPlanes = [clipSolid];
  mat.clipShadows = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = p.material !== 'luz' && p.material !== 'vidro';
  mesh.receiveShadow = true;
  mesh.position.set(...p.pos);
  mesh.rotation.set(...p.rot.map(THREE.MathUtils.degToRad));
  mesh.name = p.nome;
  // ponto de chamada das etiquetas: anéis e tubos são apontados na borda, não no centro vazio
  const ring = p.forma === 'toro' || p.forma === 'tubo';
  const anchor = ring ? new THREE.Vector3(p.tam[0] / 2 - Math.min(p.tam[1], p.tam[0] * 0.45) / 2, 0, 0) : null;
  mesh.userData = { part: true, spin: p.giro * Math.PI * 2, p0: mesh.position.clone(), baseEmissive: mat.emissive?.clone(), baseIntensity: mat.emissiveIntensity, hl: 0, anchor };
  // fantasma em arame (só durante a montagem)
  const wire = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 12), wireMat);
  wire.userData.wire = true;
  mesh.add(wire);
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
    this.autoSpin = true;
    this.t = 0;
    this.highlightNames = [];
    this.highlightLabels = [];
    this.onRemove = null;
  }

  // Centro do projetor (muda quando o JARVIS vai para o lado)
  setCenter(x, y) {
    if (x === this.centerX && y === this.centerY) return;
    this.centerX = x;
    this.centerY = y;
    this.layout(false);
  }

  parts(list = this.models) {
    const out = [];
    for (const m of list) m.traverse((o) => { if (o.userData.part) out.push(o); });
    return out;
  }

  describe() {
    return this.models.map((m) => `${m.name}${m.userData.exploded ? ' (em vista explodida)' : ''} (peças: ${m.userData.partNames.slice(0, 24).join(', ')})`).join('; ');
  }

  apply(cena, modelo) {
    if (cena === 'limpar') return this.clear();
    if (!modelo || (cena !== 'nova' && cena !== 'adicionar')) return null;
    if (cena === 'nova') this.clear();
    while (this.models.length >= MAX_MODELS) this.remove(this.models[0]);
    const m = this.build(modelo);
    this.models.push(m);
    this.layout();
    this.applyHighlight();
    return m;
  }

  build(modelo) {
    const clipSolid = new THREE.Plane(new THREE.Vector3(0, -1, 0), -100);
    const clipWire = new THREE.Plane(new THREE.Vector3(0, 1, 0), 100);
    const wireMat = new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, clippingPlanes: [clipWire] });
    const inner = new THREE.Group();
    for (const p of modelo.partes) inner.add(buildPart(p, clipSolid, clipWire, wireMat));
    inner.updateMatrixWorld(true);
    box.setFromObject(inner);
    box.getSize(size);
    box.getCenter(center);
    inner.position.copy(center).negate();
    const root = new THREE.Group();
    root.name = modelo.nome;
    root.add(inner);

    // anel de varredura que sobe enquanto o modelo se monta
    const scan = new THREE.Mesh(
      new THREE.RingGeometry(0.96, 1, 96),
      new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    );
    scan.rotation.x = -Math.PI / 2;
    scene.add(scan);

    root.userData = {
      extent: Math.max(size.x, size.y, size.z, 0.001),
      height: size.y,
      centerLocal: center.clone(),
      build: 0,
      home: true,
      partNames: modelo.partes.map((p) => p.nome),
      clipSolid, clipWire, wireMat, scan,
      explode: 0, exploded: false,
      vel: null,
    };
    scene.add(root);
    return root;
  }

  // Distribui os modelos lado a lado e define o tamanho de cada um
  layout(resetHome = true) {
    const n = this.models.length;
    const fit = n === 1 ? 2.8 : n === 2 ? 2.3 : 1.9;
    const gap = n === 2 ? 3 : 3.3;
    this.models.forEach((m, i) => {
      const u = m.userData;
      const s = fit / u.extent;
      const first = u.base === undefined;
      u.base = s;
      u.target = new THREE.Vector3(this.centerX + (i - (n - 1) / 2) * gap, Math.max(this.centerY, (u.height * s) / 2 + 0.3), 0);
      if (resetHome) u.home = true;
      if (first) {
        m.position.copy(u.target);
        m.scale.setScalar(s);
      } else if (resetHome && !u.held) {
        m.scale.setScalar(s);
      }
    });
  }

  remove(m) {
    if (!this.models.includes(m)) return;
    this.models = this.models.filter((x) => x !== m);
    m.userData.leave = 1;
    m.userData.leaveScale = m.scale.x;
    this.leaving.push(m);
    this.onRemove?.(m);
  }

  clear() {
    for (const m of [...this.models]) this.remove(m);
  }

  // Joga o modelo para longe (gesto de descartar)
  fling(m, vel) {
    if (!this.models.includes(m)) return;
    m.userData.flingVel = vel.clone().multiplyScalar(1.4);
    this.remove(m);
  }

  touched() {
    this.lastTouch = performance.now();
  }

  // ---------- Vista explodida ----------
  explode(on) {
    for (const m of this.models) m.userData.exploded = on;
  }

  // Depois que a pessoa move uma peça com a mão, a posição nova vira a "de repouso"
  partMoved(part) {
    const u = part.userData;
    if (!u.off) { u.p0.copy(part.position); return; }
    u.p0.copy(part.position).addScaledVector(u.off, -(u.offK || 0));
  }

  // ---------- Destaques ----------
  setHighlight(names) {
    const list = (names || []).map((n) => ({ label: String(n).trim(), key: normalize(n) })).filter((n) => n.key.length >= 2);
    this.highlightNames = list.map((n) => n.key);
    this.highlightLabels = list.map((n) => n.label);
    this.applyHighlight();
  }

  applyHighlight() {
    // compara palavra por palavra, sem plural: "[Elétrons]" acende "Elétron 1" e "Elétron 2"
    const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
    const words = (s) => s.split(' ').filter((w) => w && !/^\d+$/.test(w)).map(stem);
    const wanted = this.highlightNames.map(words);
    for (const p of this.parts()) {
      const pw = words(normalize(p.name));
      const g = pw.length ? wanted.findIndex((hw) => hw.length && (hw.every((w) => pw.includes(w)) || pw.every((w) => hw.includes(w)))) : -1;
      p.userData.hlOn = g >= 0;
      p.userData.hlGroup = g;
    }
  }

  highlighted() {
    return this.parts().filter((p) => p.userData.hlOn);
  }

  // Peças acesas agrupadas pelo nome que o JARVIS falou: [{ label, parts }]
  highlightGroups() {
    const groups = this.highlightLabels?.map((label) => ({ label, parts: [] })) || [];
    for (const p of this.parts()) if (p.userData.hlOn && groups[p.userData.hlGroup]) groups[p.userData.hlGroup].parts.push(p);
    return groups.filter((g) => g.parts.length);
  }

  // ---------- Quadro a quadro ----------
  update(dt) {
    this.t += dt;
    const idle = performance.now() - this.lastTouch > 3500;
    for (const m of this.models) {
      const u = m.userData;

      // montagem: o plano de corte sobe e revela o modelo; acima dele só o arame
      if (u.build < 1) {
        u.build = Math.min(1, u.build + dt / BUILD_TIME);
        const e = u.build < 1 ? 1 - Math.pow(1 - u.build, 2) : 1;
        m.updateMatrixWorld(true);
        box.setFromObject(m);
        const y = box.min.y + (box.max.y - box.min.y) * e;
        u.clipSolid.constant = y;
        u.clipWire.constant = -y;
        box.getSize(size);
        const r = Math.max(size.x, size.z) * 0.62 + 0.15;
        u.scan.position.set(m.position.x, y, m.position.z);
        u.scan.scale.setScalar(r);
        u.scan.material.opacity = 0.9 * Math.sin(Math.min(1, u.build * 1.15) * Math.PI);
        if (u.build >= 1) this.finishBuild(m);
      }

      if (u.held) {
        u.home = false;
      } else {
        if (u.home && u.target) m.position.lerp(u.target, 1 - Math.exp(-dt * 4));
        // gira devagar quando ninguém está mexendo, para mostrar que é 3D
        if (idle && this.autoSpin) m.rotateOnWorldAxis(yAxis, dt * 0.18);
      }

      // vista explodida
      const goal = u.exploded ? 1 : 0;
      if (Math.abs(u.explode - goal) > 0.001) {
        u.explode += (goal - u.explode) * (1 - Math.exp(-dt * 5));
        if (Math.abs(u.explode - goal) < 0.002) u.explode = goal;
        const k = u.explode;
        m.traverse((o) => {
          const pu = o.userData;
          if (!pu.part || pu.held) return;
          if (!pu.off) {
            tmp.copy(pu.p0).sub(u.centerLocal);
            const len = tmp.length();
            pu.off = len < 1e-3 ? new THREE.Vector3() : tmp.clone().normalize().multiplyScalar(u.extent * 0.32 + len * 0.45);
          }
          pu.offK = k;
          o.position.copy(pu.p0).addScaledVector(pu.off, k);
        });
      }

      m.traverse((o) => {
        const ou = o.userData;
        if (ou.orbit) o.rotation.y += ou.orbit * dt;
        if (ou.spin && !ou.held) o.rotateY(ou.spin * dt);
        if (ou.part) {
          // destaque: a peça pulsa na cor do JARVIS enquanto ele fala dela
          ou.hl += ((ou.hlOn ? 1 : 0) - ou.hl) * Math.min(1, dt * 8);
          const mat = o.material;
          if (mat.emissive && (ou.hl > 0.01 || ou.hlWas)) {
            const pulse = ou.hl * (0.35 + 0.25 * Math.sin(this.t * 6));
            mat.emissive.copy(ou.baseEmissive).lerp(ACCENT, Math.min(1, pulse * 1.6));
            mat.emissiveIntensity = Math.max(ou.baseIntensity, pulse * 1.4);
            ou.hlWas = ou.hl > 0.01;
          }
        }
      });
    }

    for (const m of [...this.leaving]) {
      const u = m.userData;
      if (u.flingVel) {
        m.position.addScaledVector(u.flingVel, dt);
        u.flingVel.multiplyScalar(Math.exp(-dt * 1.5));
        u.leave -= dt / 0.55;
      } else {
        u.leave -= dt / 0.3;
      }
      if (u.leave <= 0) {
        scene.remove(m);
        scene.remove(u.scan);
        m.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
        u.scan.geometry.dispose();
        u.scan.material.dispose();
        u.wireMat.dispose();
        this.leaving = this.leaving.filter((x) => x !== m);
      } else {
        m.scale.setScalar(u.leaveScale * Math.max(0.001, u.leave));
        u.scan.visible = false;
      }
    }
  }

  finishBuild(m) {
    const u = m.userData;
    u.clipSolid.constant = 1e6;
    u.scan.visible = false;
    const wires = [];
    m.traverse((o) => { if (o.userData.wire) wires.push(o); });
    for (const w of wires) { w.parent.remove(w); w.geometry.dispose(); }
    m.traverse((o) => { if (o.material && o.userData.part) { o.material.clippingPlanes = null; o.material.needsUpdate = true; } });
  }
}
