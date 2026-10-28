import * as THREE from 'three';
import { scene, camera } from './stage.js';

// O JARVIS em pessoa: um robozinho flutuante feito no próprio código.
// Ele mostra o estado da conversa com o corpo: ouve inclinando a cabeça, pensa com os olhos
// indo de um lado para o outro e fala com os olhos pulsando no ritmo da voz.
const ACCENT = new THREE.Color(0x5cc8ff);

const shell = new THREE.MeshPhysicalMaterial({ color: 0xf3f5f8, roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.18 });
const trim = new THREE.MeshPhysicalMaterial({ color: 0x9aa3b0, roughness: 0.4, metalness: 0.6 });
const visorMat = new THREE.MeshPhysicalMaterial({ color: 0x05070a, roughness: 0.12, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 });
const glow = () => new THREE.MeshBasicMaterial({ color: ACCENT.clone(), toneMapped: false });

function mesh(geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = false; // a sombra do robô é a mancha suave no chão
  m.receiveShadow = false;
  return m;
}

export class Character {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'JARVIS';
    this.state = 'off';
    this.level = 0;
    this.t = 0;
    this.blink = 0;
    this.nextBlink = 2;
    this.wave = 0;
    this.lookAt = new THREE.Vector3(0, 1.6, 8);
    this.home = new THREE.Vector3(0, 0, 0);

    // corpo flutuante
    this.float = new THREE.Group();
    this.root.add(this.float);

    const body = mesh(new THREE.SphereGeometry(0.42, 48, 32), shell);
    body.scale.set(1, 1.08, 0.92);
    body.position.y = 0.62;
    this.float.add(body);
    this.chest = mesh(new THREE.TorusGeometry(0.12, 0.022, 16, 48), glow());
    this.chest.position.set(0, 0.68, 0.385);
    this.chest.rotation.x = -0.12;
    this.float.add(this.chest);
    const neck = mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.12, 32), trim);
    neck.position.y = 1.08;
    this.float.add(neck);

    // cabeça (gira para olhar)
    this.head = new THREE.Group();
    this.head.position.y = 1.5;
    this.float.add(this.head);
    const skull = mesh(new THREE.SphereGeometry(0.5, 64, 48), shell);
    skull.scale.set(1.18, 0.9, 1);
    this.head.add(skull);
    const visor = mesh(new THREE.SphereGeometry(0.5, 64, 48, Math.PI * 0.5 - Math.PI * 0.34, Math.PI * 0.68, Math.PI * 0.29, Math.PI * 0.4), visorMat);
    visor.scale.set(1.13, 0.86, 1.0);
    visor.position.z = 0.03;
    visor.rotation.y = 0;
    this.head.add(visor);

    // olhos em forma de pílula
    this.eyes = [-1, 1].map((s) => {
      const e = mesh(new THREE.CapsuleGeometry(0.055, 0.1, 8, 16), glow());
      e.position.set(s * 0.17, 0.02, 0.535);
      this.head.add(e);
      return e;
    });

    // "orelhas" com anel de luz
    [-1, 1].forEach((s) => {
      const ear = mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.1, 40), trim);
      ear.rotation.z = Math.PI / 2;
      ear.position.set(s * 0.58, 0, 0);
      this.head.add(ear);
      const ring = mesh(new THREE.TorusGeometry(0.085, 0.014, 12, 40), glow());
      ring.rotation.y = Math.PI / 2;
      ring.position.set(s * 0.635, 0, 0);
      this.head.add(ring);
    });

    // antena
    const stem = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 12), trim);
    stem.position.set(0.12, 0.52, 0);
    stem.rotation.z = -0.2;
    this.head.add(stem);
    this.tip = mesh(new THREE.SphereGeometry(0.045, 24, 16), glow());
    this.tip.position.set(0.145, 0.63, 0);
    this.head.add(this.tip);

    // mãozinhas soltas
    this.hands = [-1, 1].map((s) => {
      const h = mesh(new THREE.SphereGeometry(0.13, 32, 24), shell);
      h.scale.set(0.9, 1.1, 0.9);
      h.position.set(s * 0.6, 0.55, 0.05);
      this.float.add(h);
      return h;
    });

    // sombra suave no chão
    const shadowTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grd.addColorStop(0, 'rgba(0,0,0,0.55)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    })();
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.012;
    this.root.add(this.shadow);

    scene.add(this.root);
  }

  meshes() {
    const out = [];
    this.root.traverse((o) => { if (o.isMesh && o !== this.shadow) out.push(o); });
    return out;
  }

  greet() {
    this.wave = 1.6;
  }

  setPlace(x, z, scale) {
    this.home.set(x, 0, z);
    this.targetScale = scale;
  }

  update(dt, state, level, target) {
    this.t += dt;
    const t = this.t;
    this.level += (level - this.level) * Math.min(1, dt * 16);
    const k = 1 - Math.exp(-dt * 3);

    // posição e tamanho
    this.root.position.lerp(this.home, k);
    const s = this.root.scale.x + ((this.targetScale ?? 1) - this.root.scale.x) * k;
    this.root.scale.setScalar(s);

    // flutuar
    const bob = Math.sin(t * 1.6) * 0.06;
    this.float.position.y = 0.35 + bob;
    this.shadow.scale.setScalar(1 - bob * 1.5);
    this.shadow.material.opacity = state === 'off' ? 0.6 : 0.85 - bob * 2;

    // olhar: vira o corpo e a cabeça para o alvo (mão, mouse, modelo ou a câmera)
    const look = target || camera.position;
    const local = this.root.worldToLocal(look.clone());
    const yaw = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -1.1, 1.1);
    const pitch = THREE.MathUtils.clamp(-Math.atan2(local.y - 1.85 * s, Math.hypot(local.x, local.z)), -0.45, 0.35);
    this.float.rotation.y += (yaw * 0.35 - this.float.rotation.y) * k;
    let tilt = 0;
    if (state === 'listening' || state === 'hearing') tilt = 0.14 + (state === 'hearing' ? 0.06 : 0);
    if (state === 'off') tilt = 0;
    const nod = state === 'speaking' ? Math.sin(t * 7) * 0.035 * Math.min(1, this.level * 3) : 0;
    this.head.rotation.y += (yaw * 0.65 - this.head.rotation.y) * k * 1.5;
    this.head.rotation.x += (pitch * 0.7 + nod + (state === 'off' ? 0.35 : 0) - this.head.rotation.x) * k * 1.5;
    this.head.rotation.z += (tilt - this.head.rotation.z) * k;

    // olhos
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) { this.blink = 0.16; this.nextBlink = 2.5 + Math.random() * 3.5; }
    this.blink = Math.max(0, this.blink - dt);
    const blinkK = this.blink > 0 ? Math.abs(Math.sin((this.blink / 0.16) * Math.PI)) : 0;
    const dim = state === 'off' ? 0.25 : 1;
    const shift = state === 'thinking' ? Math.sin(t * 5) * 0.06 : 0;
    const speakK = state === 'speaking' ? Math.min(1, this.level * 2.2) : 0;
    this.eyes.forEach((e, i) => {
      const open = state === 'off' ? 0.25 : 1 - blinkK * 0.92;
      e.scale.set(1 + speakK * 0.18, Math.max(0.08, open * (1 - speakK * 0.35)), 1);
      e.position.x = (i ? 0.17 : -0.17) + shift;
      e.material.color.copy(ACCENT).multiplyScalar(dim * (0.85 + speakK * 0.6));
    });

    // luzes do peito e da antena
    const pulse = state === 'thinking' ? 0.6 + 0.4 * Math.sin(t * 9)
      : state === 'hearing' ? 1.25
      : state === 'speaking' ? 0.8 + speakK * 0.8
      : state === 'listening' ? 0.85 + 0.15 * Math.sin(t * 2)
      : 0.25;
    this.tip.material.color.copy(ACCENT).multiplyScalar(pulse);
    this.chest.material.color.copy(ACCENT).multiplyScalar(state === 'off' ? 0.2 : 0.55 + speakK * 0.9);
    this.chest.rotation.z += dt * (state === 'thinking' ? 4 : 0.4);

    // mãos: balançam junto, e uma acena quando ele cumprimenta
    this.wave = Math.max(0, this.wave - dt);
    this.hands.forEach((h, i) => {
      const side = i ? 1 : -1;
      const sway = Math.sin(t * 1.6 + i * 1.3) * 0.04;
      let y = 0.55 + sway, x = side * 0.6, z = 0.05;
      if (i === 1 && this.wave > 0) {
        y = 1.05 + Math.sin(this.wave * 3) * 0.05;
        x = 0.72 + Math.sin(this.wave * 14) * 0.08;
        z = 0.15;
      } else if (state === 'speaking') {
        y += Math.sin(t * 3 + i * 2) * 0.05 * Math.min(1, this.level * 3);
      }
      h.position.x += (x - h.position.x) * k * 2.5;
      h.position.y += (y - h.position.y) * k * 2.5;
      h.position.z += (z - h.position.z) * k * 2.5;
    });
  }
}
