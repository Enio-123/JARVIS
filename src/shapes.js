import * as THREE from 'three';
import { mergeGeometries } from '../vendor/three-addons/utils/BufferGeometryUtils.js';
import { edgeTable, triTable } from '../vendor/three-addons/objects/MarchingCubes.js';

// Formas além das primitivas: superfícies orgânicas (como massinha), tubos que seguem uma curva,
// peças de torno, recortes extrudados, engrenagens e molas. Com elas o JARVIS consegue montar
// órgãos, corpos, animais, vasos sanguíneos, peças de máquinas... em vez de caixas.

// ---------- Orgânico: bolas e bastões fundidos (campo de distância + marching cubes) ----------
const BIG = 1e4;
const MAX_POINTS = 240000;

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// Distância até uma cápsula que afina (raio r1 em a, r2 em b), de Inigo Quilez
function roundCone(p, x, y, z) {
  const pax = x - p.ax, pay = y - p.ay, paz = z - p.az;
  const yy = pax * p.bax + pay * p.bay + paz * p.baz;
  const zz = yy - p.l2;
  const qx = pax * p.l2 - p.bax * yy, qy = pay * p.l2 - p.bay * yy, qz = paz * p.l2 - p.baz * yy;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = yy * yy * p.l2;
  const z2 = zz * zz * p.l2;
  const k = Math.sign(p.rr) * p.rr * p.rr * x2;
  if (Math.sign(zz) * p.a2 * z2 > k) return Math.sqrt(x2 + z2) * p.il2 - p.r2;
  if (Math.sign(yy) * p.a2 * y2 < k) return Math.sqrt(x2 + y2) * p.il2 - p.r1;
  return (Math.sqrt(x2 * p.a2 * p.il2) + yy * p.rr) * p.il2 - p.r1;
}

function primitives(bolas, bastoes) {
  const out = [];
  for (const b of bolas) {
    if (b.length >= 6) out.push({ t: 1, x: b[0], y: b[1], z: b[2], rx: b[3], ry: b[4], rz: b[5], r: Math.max(b[3], b[4], b[5]) });
    else out.push({ t: 0, x: b[0], y: b[1], z: b[2], r: b[3] });
  }
  for (const s of bastoes) {
    const [ax, ay, az, bx, by, bz, r1, r2 = r1] = s;
    const bax = bx - ax, bay = by - ay, baz = bz - az;
    const l2 = bax * bax + bay * bay + baz * baz;
    const rr = r1 - r2;
    const a2 = l2 - rr * rr;
    // pontas coladas ou uma bola engolindo a outra: vira só a bola maior
    if (l2 < 1e-8 || a2 <= 1e-8) {
      const big = r1 >= r2;
      out.push({ t: 0, x: big ? ax : bx, y: big ? ay : by, z: big ? az : bz, r: Math.max(r1, r2) });
      continue;
    }
    out.push({ t: 2, ax, ay, az, bx, by, bz, bax, bay, baz, l2, rr, a2, il2: 1 / l2, r1, r2, r: Math.max(r1, r2) });
  }
  return out;
}

function dist(p, x, y, z) {
  if (p.t === 0) return Math.hypot(x - p.x, y - p.y, z - p.z) - p.r;
  if (p.t === 1) {
    const dx = x - p.x, dy = y - p.y, dz = z - p.z;
    const k0 = Math.hypot(dx / p.rx, dy / p.ry, dz / p.rz);
    const k1 = Math.hypot(dx / (p.rx * p.rx), dy / (p.ry * p.ry), dz / (p.rz * p.rz));
    return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(p.rx, p.ry, p.rz);
  }
  return roundCone(p, x, y, z);
}

function bounds(p) {
  if (p.t === 2) {
    return [Math.min(p.ax, p.bx) - p.r, Math.min(p.ay, p.by) - p.r, Math.min(p.az, p.bz) - p.r,
      Math.max(p.ax, p.bx) + p.r, Math.max(p.ay, p.by) + p.r, Math.max(p.az, p.bz) + p.r];
  }
  const rx = p.t === 1 ? p.rx : p.r, ry = p.t === 1 ? p.ry : p.r, rz = p.t === 1 ? p.rz : p.r;
  return [p.x - rx, p.y - ry, p.z - rz, p.x + rx, p.y + ry, p.z + rz];
}

// Tamanho da célula: fino o bastante para o menor detalhe, sem passar do limite de pontos.
// quality < 1 deixa mais leve (celulares).
function cellSize(lo, hi, minR, quality, maxPoints = MAX_POINTS) {
  const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  let h = THREE.MathUtils.clamp(Math.min(minR / 2.2, ext / 46), ext / 150, ext / 22) / quality;
  const max = maxPoints * quality * quality;
  const count = () => ((hi[0] - lo[0]) / h + 3) * ((hi[1] - lo[1]) / h + 3) * ((hi[2] - lo[2]) / h + 3);
  if (count() > max) h *= Math.cbrt(count() / max);
  return h;
}

// kAbs: suavidade da junção em unidades do modelo (em vez de proporcional ao tamanho das bolas)
export function organicGeometry(bolas = [], bastoes = [], suave = 0.35, quality = 1, kAbs = null) {
  const prims = primitives(bolas, bastoes);
  if (!prims.length) return new THREE.SphereGeometry(0.5, 32, 16);
  const avgR = prims.reduce((s, p) => s + p.r, 0) / prims.length;
  const minR = prims.reduce((m, p) => Math.min(m, p.t === 1 ? Math.min(p.rx, p.ry, p.rz) : p.t === 2 ? Math.min(p.r1, p.r2) : p.r), Infinity);
  const k = kAbs ?? Math.max(1e-4, THREE.MathUtils.clamp(suave, 0.02, 1.2) * avgR);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    const b = bounds(p);
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b[a] - k); hi[a] = Math.max(hi[a], b[a + 3] + k); }
  }
  const h = cellSize(lo, hi, minR, quality);
  const ox = lo[0] - h, oy = lo[1] - h, oz = lo[2] - h;
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 3, ny = Math.ceil((hi[1] - lo[1]) / h) + 3, nz = Math.ceil((hi[2] - lo[2]) / h) + 3;
  const sy = nx, sz = nx * ny;
  const field = new Float32Array(nx * ny * nz).fill(BIG);

  // cada forma só mexe na região em volta dela
  for (const p of prims) {
    const b = bounds(p);
    const pad = k + 2 * h;
    const i0 = Math.max(0, Math.floor((b[0] - pad - ox) / h)), i1 = Math.min(nx - 1, Math.ceil((b[3] + pad - ox) / h));
    const j0 = Math.max(0, Math.floor((b[1] - pad - oy) / h)), j1 = Math.min(ny - 1, Math.ceil((b[4] + pad - oy) / h));
    const k0 = Math.max(0, Math.floor((b[2] - pad - oz) / h)), k1 = Math.min(nz - 1, Math.ceil((b[5] + pad - oz) / h));
    for (let kk = k0; kk <= k1; kk++) {
      const z = oz + kk * h;
      for (let j = j0; j <= j1; j++) {
        const y = oy + j * h;
        let q = i0 + j * sy + kk * sz;
        for (let i = i0; i <= i1; i++, q++) {
          const d = dist(p, ox + i * h, y, z);
          const f = field[q];
          field[q] = f >= BIG ? d : smin(f, d, k);
        }
      }
    }
  }
  return polygonize(field, nx, ny, nz, ox, oy, oz, h);
}

// Marching cubes sobre o campo (negativo = dentro). Vértices compartilhados entre células vizinhas
// e normais vindas do gradiente do campo, para a superfície sair lisa.
function polygonize(field, nx, ny, nz, ox, oy, oz, h) {
  const sy = nx, sz = nx * ny;
  const N = nx * ny * nz;
  const vx = new Int32Array(N), vy = new Int32Array(N), vz = new Int32Array(N); // índice+1 do vértice em cada aresta
  const pos = [], nor = [], idx = [];
  const grad = (q, i, j, k, out) => {
    out[0] = field[i < nx - 1 ? q + 1 : q] - field[i > 0 ? q - 1 : q];
    out[1] = field[j < ny - 1 ? q + sy : q] - field[j > 0 ? q - sy : q];
    out[2] = field[k < nz - 1 ? q + sz : q] - field[k > 0 ? q - sz : q];
  };
  const ga = [0, 0, 0], gb = [0, 0, 0];
  // axis 0/1/2 = aresta em x/y/z começando no ponto (i, j, k)
  const vertex = (axis, i, j, k) => {
    const q = i + j * sy + k * sz;
    const map = axis === 0 ? vx : axis === 1 ? vy : vz;
    if (map[q]) return map[q] - 1;
    const i2 = i + (axis === 0), j2 = j + (axis === 1), k2 = k + (axis === 2);
    const q2 = i2 + j2 * sy + k2 * sz;
    const a = field[q], b = field[q2];
    const t = Math.abs(a - b) > 1e-12 ? a / (a - b) : 0.5;
    pos.push(ox + (i + (axis === 0) * t) * h, oy + (j + (axis === 1) * t) * h, oz + (k + (axis === 2) * t) * h);
    grad(q, i, j, k, ga);
    grad(q2, i2, j2, k2, gb);
    let gx = ga[0] + (gb[0] - ga[0]) * t, gy = ga[1] + (gb[1] - ga[1]) * t, gz = ga[2] + (gb[2] - ga[2]) * t;
    const l = Math.hypot(gx, gy, gz) || 1;
    nor.push(gx / l, gy / l, gz / l);
    map[q] = pos.length / 3;
    return map[q] - 1;
  };
  const ev = new Int32Array(12);
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const q = i + j * sy + k * sz;
        const c0 = field[q], c1 = field[q + 1], c2 = field[q + 1 + sy], c3 = field[q + sy];
        const c4 = field[q + sz], c5 = field[q + 1 + sz], c6 = field[q + 1 + sy + sz], c7 = field[q + sy + sz];
        let ci = 0;
        if (c0 > 0) ci |= 1;
        if (c1 > 0) ci |= 2;
        if (c2 > 0) ci |= 4;
        if (c3 > 0) ci |= 8;
        if (c4 > 0) ci |= 16;
        if (c5 > 0) ci |= 32;
        if (c6 > 0) ci |= 64;
        if (c7 > 0) ci |= 128;
        const bits = edgeTable[ci];
        if (!bits) continue;
        if (bits & 1) ev[0] = vertex(0, i, j, k);
        if (bits & 2) ev[1] = vertex(1, i + 1, j, k);
        if (bits & 4) ev[2] = vertex(0, i, j + 1, k);
        if (bits & 8) ev[3] = vertex(1, i, j, k);
        if (bits & 16) ev[4] = vertex(0, i, j, k + 1);
        if (bits & 32) ev[5] = vertex(1, i + 1, j, k + 1);
        if (bits & 64) ev[6] = vertex(0, i, j + 1, k + 1);
        if (bits & 128) ev[7] = vertex(1, i, j, k + 1);
        if (bits & 256) ev[8] = vertex(2, i, j, k);
        if (bits & 512) ev[9] = vertex(2, i + 1, j, k);
        if (bits & 1024) ev[10] = vertex(2, i + 1, j + 1, k);
        if (bits & 2048) ev[11] = vertex(2, i, j + 1, k);
        const o = ci << 4;
        for (let n = 0; triTable[o + n] !== -1; n += 3) idx.push(ev[triTable[o + n]], ev[triTable[o + n + 1]], ev[triTable[o + n + 2]]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  // a ordem dos triângulos da tabela é a mesma para todos: confere um e vira tudo se estiver ao contrário
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    if (Math.hypot(fx, fy, fz) < 1e-12) continue;
    if (fx * nor[a] + fy * nor[a + 1] + fz * nor[a + 2] < 0) {
      for (let s = 0; s < idx.length; s += 3) { const tmp = idx[s + 1]; idx[s + 1] = idx[s + 2]; idx[s + 2] = tmp; }
    }
    break;
  }
  g.setIndex(idx);
  return g;
}

// ---------- Curva: tubo que passa pelos pontos, afinando de raio a raioFim ----------
// radial: lados do tubo (menos lados para tubos finos que aparecem pequenos)
export function tubeGeometry(pontos, raio, raioFim = raio, radiusAt = null, radial = 18) {
  const pts = pontos.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  return taperedTube(curve, raio, raioFim, radiusAt, radial);
}

// radiusAt(t, comprimento): raio em cada ponto (opcional); sem ele, vai de r0 a r1
function taperedTube(curve, r0, r1, radiusAt = null, radial = 18) {
  const len = curve.getLength();
  const seg = THREE.MathUtils.clamp(Math.round((len / (Math.min(r0, r1) * 0.6 + 1e-3)) * (radial / 18)), 16, radiusAt ? 600 : 260);
  const rAt = radiusAt || ((t) => r0 + (r1 - r0) * t);
  const g = new THREE.TubeGeometry(curve, seg, r0, radial, false);
  if (radiusAt || Math.abs(r1 - r0) > 1e-6) {
    const pos = g.attributes.position;
    const c = new THREE.Vector3(), v = new THREE.Vector3();
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      curve.getPointAt(t, c);
      const s = rAt(t, len) / r0;
      for (let j = 0; j <= radial; j++) {
        const n = i * (radial + 1) + j;
        v.fromBufferAttribute(pos, n).sub(c).multiplyScalar(s).add(c);
        pos.setXYZ(n, v.x, v.y, v.z);
      }
    }
    g.computeVertexNormals();
  }
  // pontas arredondadas
  const a = curve.getPointAt(0), b = curve.getPointAt(1);
  const capA = new THREE.SphereGeometry(rAt(0, len), radial, Math.max(6, radial >> 1)).translate(a.x, a.y, a.z);
  const capB = new THREE.SphereGeometry(rAt(1, len), radial, Math.max(6, radial >> 1)).translate(b.x, b.y, b.z);
  return mergeGeometries([g, capA, capB]);
}

// ---------- Mola: hélice em pé no eixo y ----------
class Helix extends THREE.Curve {
  constructor(r, h, turns) { super(); this.r = r; this.h = h; this.turns = turns; }
  getPoint(t, out = new THREE.Vector3()) {
    const a = t * this.turns * Math.PI * 2;
    return out.set(Math.cos(a) * this.r, (t - 0.5) * this.h, Math.sin(a) * this.r);
  }
}

export function springGeometry(w, h, voltas = 6, fio = 0.12) {
  const wire = Math.max(0.01, Math.min(fio, w * 0.25));
  return taperedTube(new Helix(w / 2 - wire, h - wire * 2, THREE.MathUtils.clamp(voltas, 1, 30)), wire, wire);
}

// ---------- Torno: perfil [[raio, altura], ...] girado em volta do eixo y ----------
export function latheGeometry(perfil) {
  const pts = perfil.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y));
  return new THREE.LatheGeometry(pts, 72);
}

// ---------- Extrusão: contorno [[x, y], ...] no plano xy com espessura em z ----------
export function extrudeGeometry(contorno, profundidade = 0.2) {
  const shape = new THREE.Shape(contorno.map(([x, y]) => new THREE.Vector2(x, y)));
  const ext = Math.max(...contorno.map((p) => Math.abs(p[0]))) + Math.max(...contorno.map((p) => Math.abs(p[1])));
  const bevel = Math.min(profundidade * 0.18, ext * 0.03);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.005, profundidade - bevel * 2),
    bevelEnabled: bevel > 0.002, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 16,
  });
  g.translate(0, 0, -profundidade / 2 + bevel);
  return g;
}

// ---------- Engrenagem: de frente (eixo em z), diâmetro w e espessura d ----------
export function gearGeometry(w, d, dentes = 16, furo = 0.25) {
  const n = Math.round(THREE.MathUtils.clamp(dentes, 5, 80));
  const R = w / 2;
  const tooth = Math.min(R * 0.18, ((Math.PI * 2 * R) / n) * 0.5);
  const r = R - tooth;
  const shape = new THREE.Shape();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const s = (Math.PI * 2) / n;
    const pts = [[r, a], [r, a + s * 0.12], [R, a + s * 0.28], [R, a + s * 0.52], [r, a + s * 0.68]];
    pts.forEach(([rad, ang], k) => {
      const x = Math.cos(ang) * rad, y = Math.sin(ang) * rad;
      if (i === 0 && k === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    });
  }
  shape.closePath();
  const hr = THREE.MathUtils.clamp(furo, 0, 0.8) * r;
  if (hr > 0.01) {
    const hole = new THREE.Path();
    hole.absarc(0, 0, hr, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  const bevel = Math.min(d * 0.12, tooth * 0.2);
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.005, d - bevel * 2), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 24 });
  g.translate(0, 0, -d / 2 + bevel);
  return g;
}

// ---------- Material de holograma: transparente com brilho nas bordas (pele, campos, esboços) ----------
export function holoMaterial(color, opacity = 1) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uGlow: { value: 0 },
      uOpacity: { value: opacity },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <clipping_planes_pars_vertex>
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <clipping_planes_pars_fragment>
      uniform vec3 uColor;
      uniform float uGlow;
      uniform float uOpacity;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        #include <clipping_planes_fragment>
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float rim = pow(f, 2.4);
        float a = clamp((0.035 + rim * 0.75 + uGlow * 0.3) * uOpacity, 0.0, 1.0);
        gl_FragColor = vec4(uColor * (0.5 + rim * 1.3 + uGlow * 0.8), a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    clipping: true,
  });
  mat.userData.holo = true;
  return mat;
}
