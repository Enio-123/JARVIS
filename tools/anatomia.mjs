// Gera os pacotes de anatomia do JARVIS (assets/anatomia/<pacote>.json + .bin).
//
// Fonte: BodyParts3D 4.0, © The Database Center for Life Science, licença CC BY 4.0
// (https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html). O script lê a versão já convertida para
// metros / Y para cima do projeto human-atlas (https://github.com/ashemag/human-atlas, pasta public/models:
// atlas.json e body-N.bin.gz), que também é CC BY 4.0 nos dados.
//
// Uso:
//   cd tools && npm install
//   node anatomia.mjs <pasta com atlas.json e bin/body-N.bin.gz> [pacote ...]
//
// Por cima do atlas, este script:
// - junta as 2.234 peças em grupos com nome em português (é por esses nomes que o JARVIS destaca as partes);
// - separa a parede dos ventrículos em ventrículo esquerdo e direito;
// - gera os pulmões, que o atlas não tem (só a árvore dos brônquios): o volume dentro da caixa torácica,
//   acima do diafragma e fora do mediastino, dividido em lobos pelos brônquios de cada lobo;
// - simplifica cada grupo até o orçamento de triângulos e grava tudo quantizado e comprimido com o
//   meshoptimizer (o site decodifica com vendor/meshopt_decoder.module.js).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets/anatomia');
const [SRC, ...ONLY] = process.argv.slice(2);
if (!SRC) {
  console.error('uso: node anatomia.mjs <pasta com atlas.json e bin/> [pacote ...]');
  process.exit(1);
}
await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;

// ---------- Atlas ----------
const atlas = JSON.parse(fs.readFileSync(path.join(SRC, 'atlas.json'), 'utf8'));
const chunks = atlas.chunks.map((c) => {
  const file = path.join(SRC, 'bin', path.basename(c.url));
  const b = fs.existsSync(file) ? fs.readFileSync(file) : zlib.gunzipSync(fs.readFileSync(file + '.gz'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
});
const PARTS = atlas.parts;

function partMesh(p) {
  const ab = chunks[p.chunk];
  const pos = new Float32Array(ab, p.positions, p.vertexCount * 3).slice();
  const n16 = new Int16Array(ab, p.normals, p.vertexCount * 3);
  const nrm = new Float32Array(n16.length);
  for (let i = 0; i < n16.length; i += 3) {
    const l = Math.hypot(n16[i], n16[i + 1], n16[i + 2]) || 1;
    nrm[i] = n16[i] / l;
    nrm[i + 1] = n16[i + 1] / l;
    nrm[i + 2] = n16[i + 2] / l;
  }
  return { pos, nrm, idx: new Uint32Array(ab, p.indices, p.indexCount).slice() };
}

// Peças por sistema e nome (os nomes do atlas são os do FMA, em inglês)
function pick({ sys, re, not, ids } = {}) {
  const list = PARTS.filter((p) => (!sys || [].concat(sys).includes(p.system)) && (!re || re.test(p.name)) && (!not || !not.test(p.name)) && (!ids || ids.includes(p.id)));
  if (!list.length) throw new Error(`nenhuma peça para ${re ?? ids}`);
  return list;
}
const meshOf = (rules) => merge([].concat(rules).flatMap((r) => pick(r)).map(partMesh));

// ---------- Malhas ----------
function merge(list) {
  let nv = 0, ni = 0;
  for (const m of list) { nv += m.pos.length / 3; ni += m.idx.length; }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let v = 0, i = 0;
  for (const m of list) {
    pos.set(m.pos, v * 3);
    nrm.set(m.nrm, v * 3);
    for (let k = 0; k < m.idx.length; k++) idx[i + k] = m.idx[k] + v;
    v += m.pos.length / 3;
    i += m.idx.length;
  }
  return { pos, nrm, idx };
}

// Tira os vértices que nenhum triângulo usa
function compact(m) {
  const map = new Int32Array(m.pos.length / 3).fill(-1);
  let n = 0;
  for (const v of m.idx) if (map[v] < 0) map[v] = n++;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  for (let v = 0; v < map.length; v++) {
    const t = map[v];
    if (t < 0) continue;
    pos.set(m.pos.subarray(v * 3, v * 3 + 3), t * 3);
    nrm.set(m.nrm.subarray(v * 3, v * 3 + 3), t * 3);
  }
  return { pos, nrm, idx: Uint32Array.from(m.idx, (v) => map[v]) };
}

// Fica só com os triângulos cujo centro passa no teste (recorte de vasos compridos, pele do tronco...)
function crop(m, test) {
  const keep = [];
  const p = m.pos;
  for (let t = 0; t < m.idx.length; t += 3) {
    const a = m.idx[t] * 3, b = m.idx[t + 1] * 3, c = m.idx[t + 2] * 3;
    if (test((p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3)) keep.push(m.idx[t], m.idx[t + 1], m.idx[t + 2]);
  }
  return compact({ pos: m.pos, nrm: m.nrm, idx: Uint32Array.from(keep) });
}

const tris = (m) => m.idx.length / 3;

// Junta vértices repetidos na mesma posição (senão o simplificador trata a costura como borda e trava)
function weld(m) {
  const map = new Map();
  const remap = new Uint32Array(m.pos.length / 3);
  const pos = [], nrm = [];
  for (let v = 0; v < remap.length; v++) {
    const key = `${Math.round(m.pos[v * 3] * 1e5)},${Math.round(m.pos[v * 3 + 1] * 1e5)},${Math.round(m.pos[v * 3 + 2] * 1e5)}`;
    let t = map.get(key);
    if (t === undefined) {
      t = pos.length / 3;
      map.set(key, t);
      pos.push(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]);
      nrm.push(0, 0, 0);
    }
    remap[v] = t;
    for (let a = 0; a < 3; a++) nrm[t * 3 + a] += m.nrm[v * 3 + a];
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
    nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
  }
  // tira triângulos que ficaram degenerados
  const idx = [];
  for (let t = 0; t < m.idx.length; t += 3) {
    const a = remap[m.idx[t]], b = remap[m.idx[t + 1]], c = remap[m.idx[t + 2]];
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  return { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), idx: Uint32Array.from(idx) };
}

// Simplifica até o orçamento (o erro máximo é relativo ao tamanho do grupo)
function simplify(m, maxTris, err = 0.004) {
  if (!maxTris || tris(m) <= maxTris) return m;
  m = weld(m);
  const [idx] = MeshoptSimplifier.simplify(m.idx, m.pos, 3, Math.floor(maxTris) * 3, err);
  return compact({ pos: m.pos, nrm: m.nrm, idx });
}

function bounds(m) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.pos.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], m.pos[i + a]);
      max[a] = Math.max(max[a], m.pos[i + a]);
    }
  }
  return { min, max };
}

// Normais pela própria malha (para malhas geradas aqui)
function vertexNormals(m) {
  const n = new Float32Array(m.pos.length);
  const p = m.pos;
  for (let t = 0; t < m.idx.length; t += 3) {
    const a = m.idx[t] * 3, b = m.idx[t + 1] * 3, c = m.idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { n[v] += nx; n[v + 1] += ny; n[v + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

// ---------- Divisão de uma malha pela peça mais próxima (parede dos ventrículos -> esquerdo / direito) ----------
// Cada vértice recebe f = (distância até A) - (distância até B), suavizada pela malha; os triângulos que
// cruzam f = 0 são cortados exatamente na fronteira, então a divisão fica com borda limpa.
function nearestDist(points, seeds) {
  const cell = 0.004;
  const grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < seeds.length; i += 3) {
    const k = key(seeds[i], seeds[i + 1], seeds[i + 2]);
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(i);
  }
  const out = new Float32Array(points.length / 3);
  for (let v = 0; v < out.length; v++) {
    const x = points[v * 3], y = points[v * 3 + 1], z = points[v * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = Infinity;
    for (let r = 0; r < 40 && (best === Infinity || (r - 1) * cell < Math.sqrt(best)); r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
        const l = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!l) continue;
        for (const s of l) {
          const d = (seeds[s] - x) ** 2 + (seeds[s + 1] - y) ** 2 + (seeds[s + 2] - z) ** 2;
          if (d < best) best = d;
        }
      }
    }
    out[v] = Math.sqrt(best);
  }
  return out;
}

function splitMesh(m, seedA, seedB, smooth = 6) {
  const da = nearestDist(m.pos, seedA.pos), db = nearestDist(m.pos, seedB.pos);
  let f = Float32Array.from(da, (a, i) => a - db[i]);
  // suaviza f pelos vizinhos da malha (a fronteira fica sem serrilhado)
  const nb = Array.from({ length: f.length }, () => []);
  for (let t = 0; t < m.idx.length; t += 3) {
    for (let e = 0; e < 3; e++) { const a = m.idx[t + e], b = m.idx[t + (e + 1) % 3]; nb[a].push(b); nb[b].push(a); }
  }
  for (let it = 0; it < smooth; it++) {
    const g = new Float32Array(f.length);
    for (let v = 0; v < f.length; v++) {
      let s = f[v], n = 1;
      for (const u of nb[v]) { s += f[u]; n++; }
      g[v] = s / n;
    }
    f = g;
  }
  return splitByField(m, f);
}

// Corte reto: fica o lado em que fn(x, y, z) > 0 (vasos cortados num plano, sem borda serrilhada)
function cut(m, fn) {
  const f = new Float32Array(m.pos.length / 3);
  for (let v = 0; v < f.length; v++) f[v] = -fn(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]);
  return compact(splitByField(m, f)[0]);
}

// Divide a malha onde o campo f (um valor por vértice) troca de sinal: [f <= 0, f > 0]
function splitByField(m, f) {
  const sides = [{ pos: [], nrm: [], idx: [], map: new Map() }, { pos: [], nrm: [], idx: [], map: new Map() }];
  const vert = (s, key, make) => {
    let i = s.map.get(key);
    if (i === undefined) {
      const [p, n] = make();
      i = s.pos.length / 3;
      s.pos.push(...p);
      s.nrm.push(...n);
      s.map.set(key, i);
    }
    return i;
  };
  const P = (v) => [[m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]], [m.nrm[v * 3], m.nrm[v * 3 + 1], m.nrm[v * 3 + 2]]];
  const cut = (a, b) => {
    const t = f[a] / (f[a] - f[b]);
    const [pa, na] = P(a), [pb, nb2] = P(b);
    const n = na.map((x, i) => x + (nb2[i] - x) * t);
    const l = Math.hypot(...n) || 1;
    return [pa.map((x, i) => x + (pb[i] - x) * t), n.map((x) => x / l)];
  };
  for (let t = 0; t < m.idx.length; t += 3) {
    const tri = [m.idx[t], m.idx[t + 1], m.idx[t + 2]];
    const side = tri.map((v) => (f[v] <= 0 ? 0 : 1));
    if (side[0] === side[1] && side[1] === side[2]) {
      const s = sides[side[0]];
      s.idx.push(...tri.map((v) => vert(s, v, () => P(v))));
      continue;
    }
    // um vértice sozinho de um lado: triângulo de um lado, quadrilátero do outro
    const lone = side[0] !== side[1] && side[0] !== side[2] ? 0 : side[1] !== side[0] && side[1] !== side[2] ? 1 : 2;
    const a = tri[lone], b = tri[(lone + 1) % 3], c = tri[(lone + 2) % 3];
    const kab = `e${Math.min(a, b)}_${Math.max(a, b)}`, kac = `e${Math.min(a, c)}_${Math.max(a, c)}`;
    const sa = sides[side[lone]], so = sides[1 - side[lone]];
    const ia = vert(sa, a, () => P(a)), iab = vert(sa, kab, () => cut(a, b)), iac = vert(sa, kac, () => cut(a, c));
    sa.idx.push(ia, iab, iac);
    const ib = vert(so, b, () => P(b)), ic = vert(so, c, () => P(c)), jab = vert(so, kab, () => cut(a, b)), jac = vert(so, kac, () => cut(a, c));
    so.idx.push(jab, ib, ic, jab, ic, jac);
  }
  return sides.map((s) => ({ pos: Float32Array.from(s.pos), nrm: Float32Array.from(s.nrm), idx: Uint32Array.from(s.idx) }));
}

// ---------- Volumes em grade (pulmões) ----------
function makeGrid(min, max, h) {
  const nx = Math.ceil((max[0] - min[0]) / h) + 1, ny = Math.ceil((max[1] - min[1]) / h) + 1, nz = Math.ceil((max[2] - min[2]) / h) + 1;
  return { nx, ny, nz, h, o: min, n: nx * ny * nz };
}
const gi = (g, i, j, k) => i + g.nx * (j + g.ny * k);

// Para cada coluna vertical (i, k) da grade, as alturas em que a malha cruza a coluna
function columnHits(g, m) {
  const hits = new Map();
  const p = m.pos;
  for (let t = 0; t < m.idx.length; t += 3) {
    const a = m.idx[t] * 3, b = m.idx[t + 1] * 3, c = m.idx[t + 2] * 3;
    const ax = (p[a] - g.o[0]) / g.h, az = (p[a + 2] - g.o[2]) / g.h;
    const bx = (p[b] - g.o[0]) / g.h, bz = (p[b + 2] - g.o[2]) / g.h;
    const cx = (p[c] - g.o[0]) / g.h, cz = (p[c + 2] - g.o[2]) / g.h;
    const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(den) < 1e-12) continue;
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), i1 = Math.min(g.nx - 1, Math.floor(Math.max(ax, bx, cx)));
    const k0 = Math.max(0, Math.ceil(Math.min(az, bz, cz))), k1 = Math.min(g.nz - 1, Math.floor(Math.max(az, bz, cz)));
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        // pequeno desvio para a coluna nunca passar exatamente por uma aresta
        const x = i + 1e-4, z = k + 1.7e-4;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const y = l1 * p[a + 1] + l2 * p[b + 1] + l3 * p[c + 1];
        const key = i + g.nx * k;
        let l = hits.get(key);
        if (!l) hits.set(key, (l = []));
        l.push(y);
      }
    }
  }
  return hits;
}

// Marca na grade o interior de uma malha fechada (paridade ao longo de cada coluna)
function fillSolid(g, m, out) {
  for (const [key, ys] of columnHits(g, m)) {
    if (ys.length % 2) continue;
    ys.sort((a, b) => a - b);
    const i = key % g.nx, k = Math.floor(key / g.nx);
    for (let s = 0; s < ys.length; s += 2) {
      const j0 = Math.max(0, Math.ceil((ys[s] - g.o[1]) / g.h)), j1 = Math.min(g.ny - 1, Math.floor((ys[s + 1] - g.o[1]) / g.h));
      for (let j = j0; j <= j1; j++) out[gi(g, i, j, k)] = 1;
    }
  }
  return out;
}

// Distância euclidiana exata até a semente mais próxima (Felzenszwalb & Huttenlocher), em metros
function edt(g, seed) {
  const INF = 1e20;
  const d = new Float64Array(g.n);
  for (let i = 0; i < g.n; i++) d[i] = seed[i] ? 0 : INF;
  const pass = (len, count, at) => {
    const f = new Float64Array(len), v = new Int32Array(len), z = new Float64Array(len + 1), r = new Float64Array(len);
    for (let c = 0; c < count; c++) {
      for (let q = 0; q < len; q++) f[q] = d[at(c, q)];
      let k = 0;
      v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < len; q++) {
        let s;
        for (;;) {
          s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
          if (s <= z[k] && k > 0) k--;
          else break;
        }
        if (s <= z[k]) { v[0] = q; z[0] = -INF; z[1] = INF; k = 0; continue; }
        k++;
        v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < len; q++) {
        while (z[k + 1] < q) k++;
        r[q] = (q - v[k]) ** 2 + f[v[k]];
      }
      for (let q = 0; q < len; q++) d[at(c, q)] = r[q];
    }
  };
  pass(g.nx, g.ny * g.nz, (c, q) => c * g.nx + q);
  pass(g.ny, g.nx * g.nz, (c, q) => (c % g.nx) + g.nx * (q + g.ny * Math.floor(c / g.nx)));
  pass(g.nz, g.nx * g.ny, (c, q) => c + g.nx * g.ny * q);
  const out = new Float32Array(g.n);
  for (let i = 0; i < g.n; i++) out[i] = Math.sqrt(d[i]) * g.h;
  return out;
}

function blur(g, f, sigma) {
  const r = Math.ceil(sigma * 2.5);
  const w = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const sw = w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) w[i] /= sw;
  let src = f, dst = new Float32Array(g.n);
  const axes = [[g.nx, 1], [g.ny, g.nx], [g.nz, g.nx * g.ny]];
  for (const [len, step] of axes) {
    for (let base = 0; base < g.n; base++) {
      const q = Math.floor(base / step) % len;
      let s = 0;
      for (let o = -r; o <= r; o++) {
        const qq = Math.min(len - 1, Math.max(0, q + o));
        s += w[o + r] * src[base + (qq - q) * step];
      }
      dst[base] = s;
    }
    [src, dst] = [dst, src];
  }
  return src;
}

// Superfície do volume (surface nets): um vértice por célula cortada, quadriláteros nas arestas cortadas.
// Normais pelo gradiente do campo, que já vem suave.
function surfaceNets(g, f, iso = 0.5) {
  const { nx, ny, nz, h, o } = g;
  const cell = new Int32Array(g.n).fill(-1);
  const pos = [], nrm = [], idx = [];
  const C = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const val = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          val[c] = f[gi(g, i + C[c][0], j + C[c][1], k + C[c][2])];
          if (val[c] > iso) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of E) {
          if (((mask >> a) & 1) === ((mask >> b) & 1)) continue;
          const t = (iso - val[a]) / (val[b] - val[a]);
          sx += C[a][0] + (C[b][0] - C[a][0]) * t;
          sy += C[a][1] + (C[b][1] - C[a][1]) * t;
          sz += C[a][2] + (C[b][2] - C[a][2]) * t;
          n++;
        }
        cell[gi(g, i, j, k)] = pos.length / 3;
        pos.push(o[0] + (i + sx / n) * h, o[1] + (j + sy / n) * h, o[2] + (k + sz / n) * h);
        // gradiente no centro da célula; a normal aponta para fora (onde o campo cai)
        const gx = val[1] + val[3] + val[5] + val[7] - val[0] - val[2] - val[4] - val[6];
        const gy = val[2] + val[3] + val[6] + val[7] - val[0] - val[1] - val[4] - val[5];
        const gz = val[4] + val[5] + val[6] + val[7] - val[0] - val[1] - val[2] - val[3];
        const l = Math.hypot(gx, gy, gz) || 1;
        nrm.push(-gx / l, -gy / l, -gz / l);
      }
    }
  }
  // cada aresta da grade que cruza a superfície vira um quadrilátero com as 4 células em volta
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, c, b, a, d, c);
    else idx.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const inside = f[gi(g, i, j, k)] > iso;
        if (inside !== f[gi(g, i + 1, j, k)] > iso) {
          quad(cell[gi(g, i, j - 1, k - 1)], cell[gi(g, i, j, k - 1)], cell[gi(g, i, j, k)], cell[gi(g, i, j - 1, k)], !inside);
        }
        if (inside !== f[gi(g, i, j + 1, k)] > iso) {
          quad(cell[gi(g, i - 1, j, k - 1)], cell[gi(g, i - 1, j, k)], cell[gi(g, i, j, k)], cell[gi(g, i, j, k - 1)], !inside);
        }
        if (inside !== f[gi(g, i, j, k + 1)] > iso) {
          quad(cell[gi(g, i - 1, j - 1, k)], cell[gi(g, i, j - 1, k)], cell[gi(g, i, j, k)], cell[gi(g, i - 1, j, k)], !inside);
        }
      }
    }
  }
  const m = { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), idx: Uint32Array.from(idx) };
  // confere a orientação com as normais do gradiente (se a convenção estiver invertida, vira tudo)
  const fn = vertexNormals(m);
  let dot = 0;
  for (let i = 0; i < fn.length; i++) dot += fn[i] * m.nrm[i];
  if (dot < 0) for (let t = 0; t < m.idx.length; t += 3) [m.idx[t + 1], m.idx[t + 2]] = [m.idx[t + 2], m.idx[t + 1]];
  return m;
}

// Fecho convexo 2D (cadeia monótona) e distância de um ponto até a borda (positiva dentro)
function hull2(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return null;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop(); upper.push(q); }
  const h = lower.slice(0, -1).concat(upper.slice(0, -1));
  return h.length >= 3 ? h : null;
}
function hullDist(h, x, z) {
  let d = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const l = Math.hypot(ex, ez) || 1;
    // sentido anti-horário: o interior fica à esquerda de cada aresta
    d = Math.min(d, (ex * (z - a[1]) - ez * (x - a[0])) / l);
  }
  return d;
}

// ---------- Pulmões ----------
// O atlas não traz o tecido dos pulmões, só a árvore dos brônquios. O pulmão é o que sobra da cavidade
// pleural: dentro da caixa torácica, acima do diafragma, fora do mediastino (coração, grandes vasos,
// esôfago, traqueia, coluna). Cada ponto vai para o lobo cujo brônquio está mais perto; entre lobos do
// mesmo pulmão fica uma fresta fina (as fissuras).
const LOBES = [
  { nome: 'Lobo superior do pulmão direito', re: /^Right (apical|posterior|anterior) segmental bronchial tree/, lado: 'd' },
  { nome: 'Lobo médio do pulmão direito', re: /^(Lateral|Medial) segmental bronchial tree/, lado: 'd' },
  { nome: 'Lobo inferior do pulmão direito', re: /^Right (superior|medial basal|anterior basal|lateral basal|posterior basal) segmental bronchial tree/, lado: 'd' },
  { nome: 'Lobo superior do pulmão esquerdo', re: /^(Left (apical|posterior|anterior) segmental|Superior lingular|Inferior lingular) bronchial tree/, lado: 'e' },
  { nome: 'Lobo inferior do pulmão esquerdo', re: /^Left (superior|medial basal|anterior basal|lateral basal|posterior basal) segmental bronchial tree/, lado: 'e' },
];

let lungCache = null;
function lungs() {
  if (lungCache) return lungCache;
  const t0 = Date.now();
  const mesh = meshOf;
  const cage = mesh([
    { sys: 'skeletal', re: /\brib$|costal cartilage|sternum|Manubrium|Xiphoid/ },
    { sys: 'skeletal', re: /thoracic vertebra|Seventh cervical vertebra/ },
  ]);
  const spine = mesh({ sys: 'skeletal', re: /thoracic vertebra|Seventh cervical vertebra|First lumbar vertebra/ });
  const sternum = mesh({ sys: 'skeletal', re: /sternum|Manubrium|Xiphoid/ });
  const mediastinum = mesh([
    { sys: 'cardiac', re: /^Wall of|Cavity of/ },
    { sys: 'arterial', re: /^(Ascending aorta|Arch of aorta|Descending thoracic aorta|Pulmonary trunk|Brachiocephalic trunk)$/ },
    { sys: 'venous', re: /^(Superior vena cava|Inferior vena cava)$/ },
    { sys: 'digestive', re: /^Esophagus$/ },
    { sys: 'respiratory', re: /^Trachea$/ },
    { sys: 'lymphatic', re: /lobe of thymus/ },
  ]);
  // o hilo: o pulmão encosta nesses, mas eles não entram no "miolo" do mediastino
  const hilum = mesh([
    { sys: 'respiratory', re: /^(Left main bronchus|Right main bronchus proper)$/ },
    { sys: 'arterial', re: /^(Left|Right) pulmonary artery$/ },
    { sys: 'venous', re: /pulmonary vein$/ },
  ]);
  const diaphragm = mesh({ sys: 'muscular', re: /^Diaphragm$/ });
  const lobeTrees = LOBES.map((l) => mesh({ sys: 'respiratory', re: l.re }));

  const cb = bounds(cage), db = bounds(diaphragm);
  const g = makeGrid([cb.min[0] - 0.01, db.min[1] - 0.005, cb.min[2] - 0.01], [cb.max[0] + 0.01, cb.max[1] + 0.012, cb.max[2] + 0.01], 0.0025);
  console.log(`  pulmões: grade ${g.nx}x${g.ny}x${g.nz}`);

  // diafragma: altura da face de cima em cada coluna (colunas sem diafragma copiam a vizinha)
  const top = new Float32Array(g.nx * g.nz).fill(NaN);
  for (const [key, ys] of columnHits(g, diaphragm)) top[key] = Math.max(...ys);
  for (let it = 0; it < 60; it++) {
    let left = 0;
    const next = top.slice();
    for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) {
      const key = i + g.nx * k;
      if (!Number.isNaN(top[key])) continue;
      let best = -Infinity;
      for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, kk = k + dk;
        if (ii < 0 || kk < 0 || ii >= g.nx || kk >= g.nz) continue;
        const v = top[ii + g.nx * kk];
        if (!Number.isNaN(v)) best = Math.max(best, v);
      }
      if (best > -Infinity) next[key] = best;
      else left++;
    }
    top.set(next);
    if (!left) break;
  }

  // corpos sólidos que o pulmão não pode invadir (com uma folga de alguns milímetros)
  const solid = new Uint8Array(g.n);
  for (const r of [
    { sys: 'cardiac', re: /^Wall of|Cavity of/ },
    { sys: 'arterial', re: /^(Ascending aorta|Arch of aorta|Descending thoracic aorta|Descending aorta|Pulmonary trunk|Brachiocephalic trunk|Left common carotid artery|Left subclavian artery)$/ },
    { sys: 'venous', re: /^(Superior vena cava|Inferior vena cava|Azygos vein)$/ },
    { sys: 'digestive', re: /^Esophagus$/ },
    { sys: 'respiratory', re: /^(Trachea|Left main bronchus|Right main bronchus proper)$/ },
    { sys: 'arterial', re: /^(Left|Right) pulmonary artery$/ },
    { sys: 'venous', re: /pulmonary vein$/ },
    { sys: 'skeletal', re: /thoracic vertebra|Seventh cervical vertebra|First lumbar vertebra|sternum|Manubrium|Xiphoid/ },
    { sys: 'lymphatic', re: /lobe of thymus/ },
  ]) {
    let list;
    try { list = pick(r); } catch { continue; }
    for (const p of list) fillSolid(g, partMesh(p), solid);
  }
  const awayFromSolid = edt(g, solid);

  // fatias horizontais: fecho da caixa torácica e do mediastino
  const slab = 0.01;
  const ptsNear = (m, y, filter = null) => {
    const out = [];
    for (let v = 0; v < m.pos.length; v += 3) {
      if (Math.abs(m.pos[v + 1] - y) > slab) continue;
      if (filter && !filter(m.pos[v], m.pos[v + 2])) continue;
      out.push([m.pos[v], m.pos[v + 2]]);
    }
    return out;
  };
  // distância (com sinal) até a parede da caixa torácica e até o miolo do mediastino, fatia por fatia;
  // depois o campo é suavizado em 3D para as costelas não deixarem degraus no pulmão
  const ribD = new Float32Array(g.n).fill(-0.05), midD = new Float32Array(g.n).fill(-0.05);
  for (let j = 0; j < g.ny; j++) {
    const y = g.o[1] + j * g.h;
    const ribs = hull2(ptsNear(cage, y));
    if (!ribs) continue;
    const mid = hull2(ptsNear(mediastinum, y).concat(ptsNear(sternum, y), ptsNear(spine, y, (x) => Math.abs(x) < 0.018)));
    for (let k = 0; k < g.nz; k++) {
      const z = g.o[2] + k * g.h;
      for (let i = 0; i < g.nx; i++) {
        const x = g.o[0] + i * g.h;
        const id = gi(g, i, j, k);
        ribD[id] = hullDist(ribs, x, z);
        if (mid) midD[id] = hullDist(mid, x, z);
      }
    }
  }
  const ribS = blur(g, ribD, 2.6), midS = blur(g, midD, 1.6);
  const cand = new Uint8Array(g.n);
  for (let k = 0; k < g.nz; k++) {
    for (let j = 0; j < g.ny; j++) {
      const y = g.o[1] + j * g.h;
      for (let i = 0; i < g.nx; i++) {
        const id = gi(g, i, j, k);
        if (ribS[id] < 0.012) continue; // por dentro das costelas
        if (midS[id] > -0.004) continue; // fora do mediastino (com folga)
        if (y < top[i + g.nx * k] + 0.004) continue; // acima do diafragma
        if (awayFromSolid[id] < 0.003) continue;
        cand[id] = 1;
      }
    }
  }

  // cada ponto vai para o lobo do brônquio mais perto
  const dist = lobeTrees.map((m) => {
    const seed = new Uint8Array(g.n);
    for (let v = 0; v < m.pos.length; v += 3) {
      const i = Math.round((m.pos[v] - g.o[0]) / g.h), j = Math.round((m.pos[v + 1] - g.o[1]) / g.h), k = Math.round((m.pos[v + 2] - g.o[2]) / g.h);
      if (i >= 0 && j >= 0 && k >= 0 && i < g.nx && j < g.ny && k < g.nz) seed[gi(g, i, j, k)] = 1;
    }
    return edt(g, seed);
  });
  const label = new Int8Array(g.n).fill(-1);
  for (let id = 0; id < g.n; id++) {
    if (!cand[id]) continue;
    let a = -1, da = Infinity, db2 = Infinity, b = -1;
    for (let l = 0; l < LOBES.length; l++) {
      const d = dist[l][id];
      if (d < da) { db2 = da; b = a; da = d; a = l; } else if (d < db2) { db2 = d; b = l; }
    }
    if (da > 0.08) continue;
    const gap = LOBES[a].lado === LOBES[b]?.lado ? 0.003 : 0.01; // fissura / espaço entre os pulmões
    if (db2 - da < gap) continue;
    label[id] = a;
  }

  // DEBUG_LUNGS=<pasta>: grava os campos da grade para conferir fatia por fatia
  if (process.env.DEBUG_LUNGS) {
    const dir = process.env.DEBUG_LUNGS;
    fs.writeFileSync(path.join(dir, 'grid.json'), JSON.stringify({ nx: g.nx, ny: g.ny, nz: g.nz, h: g.h, o: g.o }));
    fs.writeFileSync(path.join(dir, 'label.raw'), Buffer.from(label.buffer));
    fs.writeFileSync(path.join(dir, 'solid.raw'), Buffer.from(solid.buffer));
    fs.writeFileSync(path.join(dir, 'ribS.raw'), Buffer.from(ribS.buffer));
    fs.writeFileSync(path.join(dir, 'midS.raw'), Buffer.from(midS.buffer));
    fs.writeFileSync(path.join(dir, 'top.raw'), Buffer.from(top.buffer));
  }
  // abertura morfológica em cada lobo: tira pontas finas e pedacinhos soltos
  const masks = LOBES.map((l, n) => {
    const mask = new Uint8Array(g.n);
    for (let id = 0; id < g.n; id++) if (label[id] === n) mask[id] = 1;
    const outside = edt(g, mask.map((v) => 1 - v));
    const grow = edt(g, mask.map((v, id) => (outside[id] > 0.007 ? 1 : 0)));
    return mask.map((v, id) => (v && grow[id] <= 0.0075 ? 1 : 0));
  });
  // contorno de fora bem suave (o pulmão inteiro) e fissuras nítidas (cada lobo)
  const union = new Float32Array(g.n);
  for (const m of masks) for (let id = 0; id < g.n; id++) if (m[id]) union[id] = 1;
  const outer = blur(g, union, 3);
  const lobes = LOBES.map((l, n) => {
    const own = blur(g, Float32Array.from(masks[n]), 1.3);
    for (let id = 0; id < g.n; id++) own[id] = Math.min(own[id], outer[id]);
    const m = surfaceNets(g, own, 0.5);
    console.log(`  ${l.nome}: ${tris(m)} triângulos`);
    return m;
  });
  // "dentro do pulmão": para aparar as pontinhas dos brônquios que passariam da superfície
  const inside = (x, y, z) => {
    const i = Math.round((x - g.o[0]) / g.h), j = Math.round((y - g.o[1]) / g.h), k = Math.round((z - g.o[2]) / g.h);
    return i >= 0 && j >= 0 && k >= 0 && i < g.nx && j < g.ny && k < g.nz && outer[gi(g, i, j, k)] > 0.55;
  };
  lungCache = { lobes, inside };
  console.log(`  pulmões prontos em ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return lungCache;
}

// ---------- Grupos ----------
// Cada grupo: nome em português, cor, material do projetor e de onde vêm as peças.
const BONE = '#e8dfc9';
const g = (nome, cor, material, de, max, extra = {}) => ({ nome, cor, material, de, max, ...extra });

const SKULL = [
  { sys: 'skeletal', re: /^(Frontal bone|Occipital bone|Sphenoid bone|Ethmoid|Vomer)$|(parietal|temporal|zygomatic|nasal|palatine) bone$|maxilla$/i },
  { sys: 'sensory', re: /lacrimal bone$/ },
  { sys: 'respiratory', re: /inferior nasal concha$/ },
];
const TEETH = { sys: 'skeletal', re: /tooth$/ };

const skeletonGroups = (k = 1) => [
  g('Crânio', BONE, 'osso', SKULL, 24000 * k),
  g('Mandíbula', BONE, 'osso', { sys: 'skeletal', re: /^Mandible$/ }, 2400 * k),
  g('Dentes', '#f4f0e6', 'osso', TEETH, 6000 * k),
  g('Osso hioide', BONE, 'osso', { ids: ['FJ2772'] }, 800 * k),
  g('Vértebras cervicais', BONE, 'osso', { sys: 'skeletal', re: /^(Atlas|Axis|(Third|Fourth|Fifth|Sixth|Seventh) cervical vertebra)$/ }, 7000 * k),
  g('Vértebras torácicas', BONE, 'osso', { sys: 'skeletal', re: /thoracic vertebra$/ }, 12000 * k),
  g('Vértebras lombares', BONE, 'osso', { sys: 'skeletal', re: /lumbar vertebra$/ }, 9000 * k),
  g('Sacro', BONE, 'osso', { sys: 'skeletal', re: /^Sacrum$/ }, 3000 * k),
  g('Discos intervertebrais', '#9cc4d4', 'tecido', { sys: 'skeletal', re: /^Intervertebral disk/ }, 8000 * k, { err: 0.01 }),
  g('Esterno', BONE, 'osso', { sys: 'skeletal', re: /^(Manubrium|Body of sternum|Xiphoid process)$/ }, 3500 * k),
  g('Costelas', BONE, 'osso', { sys: 'skeletal', re: /\brib$/ }, 18000 * k),
  g('Cartilagens costais', '#cfe2e8', 'tecido', { sys: 'skeletal', re: /costal cartilage$/ }, 6000 * k),
  g('Clavículas', BONE, 'osso', { sys: 'skeletal', re: /clavicle$/ }, 1700 * k),
  g('Escápulas', BONE, 'osso', { sys: 'skeletal', re: /scapula$/ }, 6000 * k),
  g('Úmeros', BONE, 'osso', { sys: 'skeletal', re: /humerus$/ }, 2100 * k),
  g('Rádios', BONE, 'osso', { sys: 'skeletal', re: /radius$/ }, 900 * k),
  g('Ulnas', BONE, 'osso', { sys: 'skeletal', re: /ulna$/ }, 950 * k),
  g('Ossos do carpo', BONE, 'osso', { sys: 'skeletal', re: /(scaphoid|lunate|triquetral|pisiform|trapezium|trapezoid|capitate|hamate)$/ }, 4000 * k),
  g('Metacarpos', BONE, 'osso', { sys: 'skeletal', re: /metacarpal bone$/ }, 3500 * k),
  g('Falanges das mãos', BONE, 'osso', { sys: 'skeletal', re: /phalanx of (left|right) (thumb|index finger|middle finger|ring finger|little finger)$/ }, 7000 * k),
  g('Pelve', BONE, 'osso', { sys: 'skeletal', re: /hip bone$/ }, 6000 * k),
  g('Fêmures', BONE, 'osso', { sys: 'skeletal', re: /femur$/ }, 1900 * k),
  g('Patelas', BONE, 'osso', { sys: 'skeletal', re: /patella$/ }, 700 * k),
  g('Tíbias', BONE, 'osso', { sys: 'skeletal', re: /tibia$/ }, 1300 * k),
  g('Fíbulas', BONE, 'osso', { sys: 'skeletal', re: /fibula$/ }, 600 * k),
  g('Ossos do tarso', BONE, 'osso', { sys: 'skeletal', re: /(calcaneus|talus|navicular bone of (left|right) foot|cuboid bone|cuneiform bone)$/ }, 7000 * k),
  g('Metatarsos', BONE, 'osso', { sys: 'skeletal', re: /metatarsal bone$/ }, 4500 * k),
  g('Falanges dos pés', BONE, 'osso', { sys: 'skeletal', re: /phalanx of (left|right) (big toe|second toe|third toe|fourth toe|little toe)$|^Sesamoid bone/ }, 6000 * k),
];

// Esqueleto em poucas peças (para o corpo inteiro)
const skeletonCoarse = (k = 1) => [
  g('Crânio', BONE, 'osso', [...SKULL, { sys: 'skeletal', re: /^Mandible$/ }, TEETH], 16000 * k),
  g('Coluna vertebral', BONE, 'osso', { sys: 'skeletal', re: /^(Atlas|Axis|Sacrum)$|vertebra$|^Intervertebral disk/ }, 16000 * k),
  g('Caixa torácica', BONE, 'osso', { sys: 'skeletal', re: /\brib$|costal cartilage$|^(Manubrium|Body of sternum|Xiphoid process)$/ }, 16000 * k),
  g('Ossos dos braços', BONE, 'osso', { sys: 'skeletal', re: /(clavicle|scapula|humerus|radius|ulna)$/ }, 9000 * k),
  g('Ossos das mãos', BONE, 'osso', { sys: 'skeletal', re: /(scaphoid|lunate|triquetral|pisiform|trapezium|trapezoid|capitate|hamate|metacarpal bone)$|phalanx of (left|right) (thumb|index finger|middle finger|ring finger|little finger)$/ }, 7000 * k),
  g('Pelve', BONE, 'osso', { sys: 'skeletal', re: /hip bone$/ }, 4000 * k),
  g('Ossos das pernas', BONE, 'osso', { sys: 'skeletal', re: /(femur|patella|tibia|fibula)$/ }, 4500 * k),
  g('Ossos dos pés', BONE, 'osso', { sys: 'skeletal', re: /(calcaneus|talus|navicular bone of (left|right) foot|cuboid bone|cuneiform bone|metatarsal bone)$|phalanx of (left|right) (big toe|second toe|third toe|fourth toe|little toe)$|^Sesamoid bone/ }, 8000 * k),
];

// Coração: a parede única dos ventrículos é dividida em esquerdo e direito pela cavidade mais próxima
let ventricles = null;
function ventricle(side) {
  if (!ventricles) {
    const wall = meshOf({ sys: 'cardiac', re: /^Wall of ventricle$/ });
    const lv = merge(pick({ sys: 'cardiac', re: /^Cavity of left ventricle$/ }).map(partMesh));
    const rv = merge(pick({ sys: 'cardiac', re: /^Cavity of right ventricle$/ }).map(partMesh));
    ventricles = splitMesh(wall, lv, rv);
  }
  return ventricles[side === 'e' ? 0 : 1];
}
const above = (y0) => (x, y) => y - y0;
const heartVessels = (k = 1) => [
  g('Aorta', '#c8352f', 'tecido', { m: () => cut(meshOf({ sys: 'arterial', re: /^(Ascending aorta|Arch of aorta|Descending thoracic aorta)$/ }), above(1.236)) }, 2400 * k),
  g('Tronco pulmonar', '#3d64c4', 'tecido', { sys: 'arterial', re: /^(Pulmonary trunk|Left pulmonary artery|Right pulmonary artery)$/ }, 3000 * k),
  g('Veias cavas', '#3352b0', 'tecido', { m: () => cut(meshOf({ sys: 'venous', re: /^(Superior|Inferior) vena cava$/ }), above(1.236)) }, 1200 * k),
  g('Veias pulmonares', '#9c3d66', 'tecido', { sys: 'venous', re: /pulmonary vein$/ }, 2500 * k),
];
const heartGroups = () => [
  g('Ventrículo esquerdo', '#8a2428', 'tecido', { m: () => ventricle('e') }, 7000),
  g('Ventrículo direito', '#9b2f30', 'tecido', { m: () => ventricle('d') }, 5000),
  g('Átrio esquerdo', '#a53d43', 'tecido', { sys: 'cardiac', re: /^Wall of left atrium$/ }, 4000),
  g('Átrio direito', '#ad4440', 'tecido', { sys: 'cardiac', re: /^Wall of right atrium$/ }, 4000),
  g('Valva mitral', '#ecd9b4', 'tecido', { sys: 'cardiac', re: /leaflet of mitral valve$/ }, 2800),
  g('Valva tricúspide', '#ecd9b4', 'tecido', { sys: 'cardiac', re: /leaflet of tricuspid valve$/ }, 3600),
  g('Valva aórtica', '#ecd9b4', 'tecido', { sys: 'cardiac', re: /cusp of aortic valve$/ }, 1500),
  g('Valva pulmonar', '#ecd9b4', 'tecido', { sys: 'cardiac', re: /cusp of pulmonary valve$/ }, 2000),
  g('Artérias coronárias', '#d8342a', 'tecido', { sys: 'arterial', re: /coronary artery$|^Trunk of (left|right) coronary artery$/ }, 9000),
  g('Veias cardíacas', '#3f63cf', 'tecido', { sys: 'venous', re: /cardiac vein$|^Coronary sinus$/ }, 5000),
  ...heartVessels(),
];

// Cérebro: os giros do atlas agrupados por lobo
const BRAIN = '#e7a6ae';
const LUNG = '#c96f78';
const brainGroups = () => [
  g('Lobo frontal', '#5b8fd9', 'tecido', { sys: 'nervous', re: /(superior|middle|inferior) frontal gyrus$|precentral gyrus$|^Orbital gyrus$/ }, 16000),
  g('Lobo parietal', '#e9b949', 'tecido', { sys: 'nervous', re: /postcentral gyrus$|superior parietal lobule$|supramarginal gyrus$|angular gyrus$/ }, 14000),
  g('Lobo temporal', '#5fb672', 'tecido', { sys: 'nervous', re: /superior temporal gyrus$|(middle|inferior) temporal gyrus$|fusiform gyrus$|parahippocampal gyrus$/ }, 12000),
  g('Lobo occipital', '#df6b55', 'tecido', { sys: 'nervous', re: /occipital lobe$/ }, 6000),
  g('Ínsula', '#d78ac6', 'tecido', { sys: 'nervous', re: /insula$/ }, 3000),
  g('Giro do cíngulo', '#9b80dd', 'tecido', { sys: 'nervous', re: /cingulate gyrus$/ }, 2500),
  g('Substância branca', '#efe9df', 'tecido', { sys: 'nervous', re: /^White matter of (left|right) cerebral hemisphere$|internal capsule$/ }, 12000),
  g('Corpo caloso', '#f3efe6', 'tecido', { sys: 'nervous', re: /^(Corpus callosum|Septum of telencephalon)$/ }, 5000),
  g('Fórnix e comissuras', '#e7dcc8', 'tecido', { sys: 'nervous', re: /fornix of forebrain$|^Commissure of fornix|^(Anterior|Posterior) commissure$|stria terminalis$/i }, 4000),
  g('Tálamo', '#7fc2c9', 'tecido', { sys: 'nervous', re: /thalamus$|geniculate body$|^Habenula$|stria medullaris of thalamus$/ }, 4000),
  g('Hipotálamo', '#c9a35f', 'tecido', { sys: 'nervous', re: /^(Hypothalamus|Mammillary body|Tuber cinereum|Lamina terminalis)$/ }, 2500),
  g('Hipocampo', '#e48f5d', 'tecido', { sys: 'nervous', re: /hippocampus$/ }, 1600),
  g('Amígdala', '#d9564f', 'tecido', { sys: 'nervous', re: /amygdala$/ }, 800),
  g('Núcleos da base', '#9fb86a', 'tecido', { sys: 'nervous', re: /caudate nucleus$|putamen$|globus pallidus$/ }, 6000),
  g('Mesencéfalo', '#d7a08a', 'tecido', { sys: 'nervous', re: /^(Midbrain|Peduncle of midbrain|Interpeduncular fossa|Cerebral aqueduct)$|colliculus$|^Brachium of/ }, 5000),
  g('Ponte', '#cf9481', 'tecido', { sys: 'nervous', re: /^Pons$/ }, 3500),
  g('Bulbo', '#c48877', 'tecido', { sys: 'nervous', re: /^Medulla oblongata$|^Central canal of spinal cord$/ }, 2200),
  g('Cerebelo', '#b48ad8', 'tecido', { sys: 'nervous', re: /^Cerebellum$/ }, 9000),
  // (o atlas tem duas cópias de cada nervo óptico; fica a mais completa)
  g('Vias ópticas', '#f0d27a', 'tecido', [{ sys: 'nervous', re: /^Optic chiasm$|optic tract$/ }, { ids: ['FJ1772', 'FJ1819'] }], 3000),
  g('Hipófise', '#e0a26a', 'tecido', { sys: 'endocrine', re: /^Pituitary gland$/ }, 900),
  g('Glândula pineal', '#e0a26a', 'tecido', { sys: 'endocrine', re: /^Pineal body$/ }, 500),
  g('Ventrículos cerebrais', '#7fd3f0', 'tecido', [{ sys: 'cardiac', re: /ventricle$|^Interventricular foramen$/, not: /^Wall|^Cavity/ }, { sys: 'sensory', re: /^Choroid plexus/ }], 6000),
];

// Traqueia e brônquios; as pontas da árvore que passariam da superfície do pulmão gerado são aparadas
const airways = () => {
  const { inside } = lungs();
  const tree = crop(meshOf({ sys: 'respiratory', re: /bronchial tree$/ }), inside);
  return merge([meshOf({ sys: 'respiratory', re: /^(Trachea|Left main bronchus|Right main bronchus proper)$/ }), tree]);
};

// Órgãos do tronco
const ORGANS_BOX = (x, y, z) => y > 0.86 && y < 1.5;
const organGroups = (k = 1, opts = {}) => [
  ...LOBES.map((l, n) => g(l.nome, LUNG, 'tecido', { m: () => lungs().lobes[n] }, 9000 * k)),
  g('Traqueia e brônquios', '#dbe5ea', 'tecido', { m: airways }, 14000 * k),
  g('Coração', '#b23a3e', 'tecido', { sys: 'cardiac', re: /^Wall of (ventricle|left atrium|right atrium)$/ }, 7000 * k),
  g('Aorta', '#d8473f', 'tecido', { sys: 'arterial', re: /^(Ascending aorta|Arch of aorta|Descending thoracic aorta|Abdominal aorta|Brachiocephalic trunk)$/ }, 3000 * k),
  g('Veias cavas', '#3f62c4', 'tecido', { sys: 'venous', re: /^(Superior|Inferior) vena cava$/ }, 1200 * k),
  g('Tronco pulmonar', '#4f78d6', 'tecido', { sys: 'arterial', re: /^(Pulmonary trunk|Left pulmonary artery|Right pulmonary artery)$/ }, 2000 * k),
  g('Timo', '#e6b9a6', 'tecido', { sys: 'lymphatic', re: /lobe of thymus$/ }, 1200 * k),
  g('Esôfago', '#d98d7c', 'tecido', { sys: 'digestive', re: /^Esophagus$/ }, 600 * k),
  g('Fígado', '#8c3b2f', 'tecido', [{ sys: 'venous', re: /^Hepatovenous segment/ }, { sys: 'digestive', re: /^Caudate lobe of liver$/ }], 14000 * k),
  g('Vesícula biliar', '#4e9a57', 'tecido', { sys: 'digestive', re: /^Gallbladder$/ }, 900 * k),
  g('Estômago', '#e3a37f', 'tecido', { sys: 'digestive', re: /^Stomach$/ }, 1700 * k),
  g('Baço', '#7b2f4b', 'tecido', { sys: 'lymphatic', re: /^Spleen$/ }, 1200 * k),
  g('Pâncreas', '#e9c27c', 'tecido', { sys: 'digestive', re: /^Pancreas$/ }, 2000 * k),
  g('Duodeno', '#e8b48c', 'tecido', { sys: 'digestive', re: /^Duodenum$/ }, 1700 * k),
  g('Intestino delgado', '#eab593', 'tecido', { sys: 'digestive', re: /part of (jejunum|ileum)$|^Ileocecal junction$/ }, 12000 * k),
  g('Intestino grosso', '#d89a6e', 'tecido', { sys: 'digestive', re: /colon$|^Rectum$|^Taenia/ }, 12000 * k),
  g('Apêndice', '#d89a6e', 'tecido', { sys: 'digestive', re: /^Appendix$/ }, 400 * k),
  g('Rins', '#8f3c3c', 'tecido', { sys: 'urinary', re: /kidney$/ }, 3000 * k),
  g('Glândulas suprarrenais', '#e2a13f', 'tecido', { sys: 'endocrine', re: /adrenal gland$/ }, 1500 * k),
  g('Ureteres', '#e6c8a0', 'tecido', { sys: 'urinary', re: /ureter$/ }, 1500 * k),
  g('Bexiga', '#e6b088', 'tecido', { sys: 'urinary', re: /^Urinary bladder$/ }, 300 * k),
  ...(opts.diafragma ? [g('Diafragma', '#c46a5a', 'tecido', { sys: 'muscular', re: /^Diaphragm$/ }, 6000 * k)] : []),
];

const skin = (k = 1, test = null) => g('Pele', '#5cd0ff', 'holograma', { m: () => { const m = meshOf({ sys: 'integumentary', re: /^Skin$/ }); return test ? crop(m, test) : m; } }, 30000 * k);

const PACKS = {
  coracao: { nome: 'Coração humano', grupos: heartGroups },
  cerebro: { nome: 'Cérebro humano', grupos: brainGroups },
  esqueleto: { nome: 'Esqueleto humano', grupos: () => [skin(0.45), ...skeletonGroups()] },
  orgaos: {
    nome: 'Órgãos do tronco',
    grupos: () => [
      skin(0.4, ORGANS_BOX),
      ...organGroups(1),
      g('Coluna vertebral', BONE, 'osso', { sys: 'skeletal', re: /(thoracic|lumbar) vertebra$|^Sacrum$|^Intervertebral disk of (.*(thoracic|lumbar) vertebra)$/ }, 12000),
    ],
  },
  respiratorio: {
    nome: 'Sistema respiratório',
    grupos: () => [
      ...LOBES.map((l, n) => g(l.nome, LUNG, 'tecido', { m: () => lungs().lobes[n] }, 12000)),
      g('Traqueia e brônquios', '#dbe5ea', 'tecido', { m: airways }, 22000),
      g('Laringe', '#dfe8ec', 'tecido', [{ sys: 'skeletal', re: /^Thyroid cartilage$|arytenoid cartilage$|corniculate cartilage$|cuneiform cartilage$/ }, { ids: ['FJ2440'] }, { sys: 'respiratory', re: /^Epiglottis$/ }], 5000),
      g('Diafragma', '#d0705e', 'vidro', { sys: 'muscular', re: /^Diaphragm$/ }, 7000),
    ],
  },
  corpo_humano: {
    nome: 'Corpo humano',
    grupos: () => [
      skin(0.8),
      g('Cérebro', BRAIN, 'tecido', { sys: 'nervous', re: /gyrus$|lobule$|occipital lobe$|insula$|^Cerebellum$|^(Pons|Medulla oblongata|Midbrain)$/ }, 12000),
      g('Olhos', '#f2f2ee', 'tecido', { sys: 'sensory', re: /sclera$|cornea$/ }, 1500),
      ...skeletonCoarse(),
      ...organGroups(0.45),
    ],
  },
};

// ---------- Gravação ----------
function encodeGroup(m, min, size) {
  const idx = m.idx.slice();
  const [remap, n] = MeshoptEncoder.reorderMesh(idx, true, false);
  const q = new Uint16Array(n * 4);
  const nn = new Float32Array(n * 4);
  for (let v = 0; v < remap.length; v++) {
    const t = remap[v];
    if (t === 0xffffffff) continue;
    for (let a = 0; a < 3; a++) {
      q[t * 4 + a] = Math.round(((m.pos[v * 3 + a] - min[a]) / size[a]) * 65535);
      nn[t * 4 + a] = m.nrm[v * 3 + a];
    }
  }
  return {
    v: n,
    i: idx.length,
    pos: MeshoptEncoder.encodeVertexBuffer(new Uint8Array(q.buffer), n, 8),
    nrm: MeshoptEncoder.encodeVertexBuffer(MeshoptEncoder.encodeFilterOct(nn, n, 4, 8), n, 4),
    idx: MeshoptEncoder.encodeIndexBuffer(new Uint8Array(idx.buffer), idx.length, 4),
  };
}

function build(name, def) {
  const t0 = Date.now();
  console.log(`${name}: ${def.nome}`);
  const groups = def.grupos().map((spec) => {
    let m;
    if (spec.de.m) m = spec.de.m();
    else {
      m = meshOf(spec.de);
    }
    const before = tris(m);
    m = simplify(m, spec.max, spec.err);
    console.log(`  ${spec.nome}: ${before} -> ${tris(m)} triângulos`);
    return { spec, m };
  });
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const { m } of groups) {
    const b = bounds(m);
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], b.min[a]); max[a] = Math.max(max[a], b.max[a]); }
  }
  const size = max.map((x, a) => Math.max(x - min[a], 1e-6));
  const parts = [];
  let off = 0;
  const put = (u8) => {
    const at = off;
    parts.push(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength));
    off += u8.byteLength;
    const pad = (4 - (off % 4)) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); off += pad; }
    return [at, u8.byteLength];
  };
  const out = {
    versao: 1,
    nome: def.nome,
    fonte: 'BodyParts3D, © The Database Center for Life Science, CC BY 4.0',
    min,
    max,
    bytes: 0,
    grupos: groups.map(({ spec, m }) => {
      const e = encodeGroup(m, min, size);
      return { nome: spec.nome, cor: spec.cor, material: spec.material, v: e.v, i: e.i, pos: put(e.pos), nrm: put(e.nrm), idx: put(e.idx) };
    }),
  };
  out.bytes = off;
  fs.writeFileSync(path.join(OUT, `${name}.bin`), Buffer.concat(parts));
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(out));
  const total = groups.reduce((s, x) => s + tris(x.m), 0);
  console.log(`  = ${total} triângulos, ${(off / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, def] of Object.entries(PACKS)) if (!ONLY.length || ONLY.includes(name)) build(name, def);
