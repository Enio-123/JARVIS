import * as THREE from 'three';
import {
  raycast, depthOf, pointAt, toScreen, viewDirection, wrapAngle,
  keepAboveFloor, clampToBounds, physics,
} from './stage.js';

// Sistema de pegar, mover, girar, escalar e jogar objetos.
// Um "grabber" é uma mão ou o mouse: posição na tela (x, y), tamanho da mão (size) e giro do pulso (roll).
const DEPTH_K = 38; // quanto a profundidade muda quando a mão aproxima/afasta da câmera
const qTmp = new THREE.Quaternion();
const yAxis = new THREE.Vector3(0, 1, 0);
const target = new THREE.Vector3();
const tmp = new THREE.Vector3();

export class GrabSystem {
  constructor(objects, opts = {}) {
    this.objects = objects;
    this.opts = { twoHand: true, roll: true, gravity: true, pickRadius: 0, minDepth: 2.5, maxDepth: 16, ...opts };
    this.grips = new Map(); // grabber -> estado da pegada
    this.pairs = new Map(); // objeto -> controle com duas mãos
  }

  heldBy(g) {
    return this.grips.get(g)?.obj || null;
  }

  // Encontra o objeto sob o ponto (sobe na hierarquia até um item da lista)
  pick(x, y) {
    const hit = raycast(x, y, this.objects, true);
    if (hit) {
      let o = hit.object;
      while (o && !this.objects.includes(o)) o = o.parent;
      if (o) return { obj: o, point: hit.point };
    }
    if (this.opts.pickRadius) {
      let best = null, bestD = this.opts.pickRadius;
      for (const o of this.objects) {
        if (!o.visible) continue;
        const s = toScreen(o.position);
        const d = Math.hypot(s.x - x, s.y - y);
        if (!s.behind && d < bestD) { best = o; bestD = d; }
      }
      if (best) return { obj: best, point: best.position.clone() };
    }
    return null;
  }

  seed(g, o, anchor) {
    this.grips.set(g, {
      obj: o,
      depth0: depthOf(anchor),
      offset: o.position.clone().sub(anchor),
      size0: g.size,
      roll0: g.roll,
      q0: o.quaternion.clone(),
      prevPos: o.position.clone(),
      vel: new THREE.Vector3(),
    });
  }

  grab(g) {
    if (this.grips.has(g)) return null;
    const hit = this.pick(g.x, g.y);
    if (!hit) return null;
    const o = hit.obj;
    const other = [...this.grips].find(([h, s]) => h !== g && s.obj === o)?.[0];
    if (other && (!this.opts.twoHand || this.pairs.has(o))) return null;
    o.userData.held = (o.userData.held || 0) + 1;
    o.userData.vel?.set(0, 0, 0);
    if (other) {
      const mx = (g.x + other.x) / 2, my = (g.y + other.y) / 2;
      const depth = depthOf(o.position);
      this.grips.set(g, { obj: o, prevPos: o.position.clone(), vel: new THREE.Vector3() });
      this.pairs.set(o, {
        a: other, b: g,
        d0: Math.max(80, Math.hypot(g.x - other.x, g.y - other.y)),
        ang0: Math.atan2(g.y - other.y, g.x - other.x),
        s0: o.scale.x,
        q0: o.quaternion.clone(),
        depth0: depth,
        size0: (g.size + other.size) / 2,
        offset: o.position.clone().sub(pointAt(mx, my, depth)),
      });
      return o;
    }
    this.seed(g, o, hit.point);
    return o;
  }

  release(g, throwIt = true) {
    const grip = this.grips.get(g);
    if (!grip) return null;
    this.grips.delete(g);
    const o = grip.obj;
    o.userData.held = Math.max(0, (o.userData.held || 1) - 1);
    const pair = this.pairs.get(o);
    if (pair) {
      // Sobrou uma mão segurando: ela continua o controle sozinha
      this.pairs.delete(o);
      const rest = pair.a === g ? pair.b : pair.a;
      this.seed(rest, o, o.position.clone());
      this.grips.get(rest).offset.set(0, 0, 0);
      return o;
    }
    const phys = this.opts.physics;
    if (phys) {
      const v = phys.velocity(o);
      if (v) phys.setVelocity(o, throwIt ? v : tmp.set(0, 0, 0), 12);
      return o;
    }
    if (o.userData.vel) {
      if (throwIt && this.opts.gravity) {
        o.userData.vel.copy(grip.vel);
        if (o.userData.vel.length() > 10) o.userData.vel.setLength(10);
      } else {
        o.userData.vel.set(0, 0, 0);
      }
    }
    return o;
  }

  releaseAll() {
    for (const g of [...this.grips.keys()]) this.release(g, false);
  }

  // Solta tudo que estiver preso a um objeto (ex.: quando ele some da cena)
  forget(o) {
    for (const [g, s] of [...this.grips]) if (s.obj === o) this.grips.delete(g);
    this.pairs.delete(o);
    o.userData.held = 0;
  }

  update(dt) {
    for (const [o, p] of this.pairs) this.updatePair(o, p, dt);
    for (const [g, s] of this.grips) if (!this.pairs.has(s.obj)) this.updateSingle(g, s, dt);
    if (this.opts.physics) this.opts.physics.step(dt);
    else if (this.opts.gravity) {
      for (const o of this.objects) if (!o.userData.held && o.userData.vel && o.visible) physics(o, dt);
    }
  }

  updateSingle(g, s, dt) {
    const o = s.obj;
    const { minDepth, maxDepth } = this.opts;
    const depth = THREE.MathUtils.clamp(s.depth0 - (g.size - s.size0) * DEPTH_K, minDepth, maxDepth);
    pointAt(g.x, g.y, depth, target).add(s.offset);
    const rolls = this.opts.roll && g.roll !== undefined && s.roll0 !== undefined;
    if (rolls) qTmp.setFromAxisAngle(viewDirection(tmp), wrapAngle(g.roll - s.roll0)).multiply(s.q0);
    if (this.opts.physics) {
      target.y = Math.max(target.y, 0.1);
      this.opts.physics.drive(o, target, rolls ? qTmp : s.q0);
      return;
    }
    o.position.lerp(target, 1 - Math.exp(-dt * 18));
    if (rolls) o.quaternion.copy(qTmp);
    this.afterMove(o, s, dt);
  }

  updatePair(o, p, dt) {
    const { a, b } = p;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const d = Math.max(80, Math.hypot(b.x - a.x, b.y - a.y));
    const scale = THREE.MathUtils.clamp(p.s0 * (d / p.d0), 0.35, 3);
    qTmp.setFromAxisAngle(yAxis, -wrapAngle(Math.atan2(b.y - a.y, b.x - a.x) - p.ang0) * 1.5).multiply(p.q0);
    const depth = THREE.MathUtils.clamp(p.depth0 - ((a.size + b.size) / 2 - p.size0) * DEPTH_K, this.opts.minDepth, this.opts.maxDepth);
    pointAt(mx, my, depth, target).add(p.offset);
    const phys = this.opts.physics;
    if (phys) {
      if (Math.abs(scale - o.scale.x) > 0.02) phys.setScale(o, scale);
      target.y = Math.max(target.y, 0.1);
      phys.drive(o, target, qTmp);
      return;
    }
    o.scale.setScalar(scale);
    o.quaternion.copy(qTmp);
    o.position.lerp(target, 1 - Math.exp(-dt * 18));
    const sa = this.grips.get(a), sb = this.grips.get(b);
    this.afterMove(o, sa, dt);
    if (sb) sb.vel.copy(sa.vel);
  }

  afterMove(o, s, dt) {
    clampToBounds(o);
    if (this.opts.gravity) keepAboveFloor(o);
    else if (o.position.y < 0.05) o.position.y = 0.05;
    if (dt > 0) {
      tmp.copy(o.position).sub(s.prevPos).divideScalar(dt);
      s.vel.lerp(tmp, 0.35);
    }
    s.prevPos.copy(o.position);
  }

  // Objetos sob o cursor de quem não está segurando nada (para destacar)
  hovered(grabbers) {
    const set = new Set();
    for (const g of grabbers) {
      if (!g.present || this.grips.has(g)) continue;
      const hit = this.pick(g.x, g.y);
      if (hit) set.add(hit.obj);
    }
    return set;
  }
}

