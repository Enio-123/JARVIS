// Modelos prontos de anatomia: peças reais do BodyParts3D 4.0 (© The Database Center for Life Science,
// licença CC BY 4.0), agrupadas com nomes em português e comprimidas por tools/anatomia.mjs em
// assets/anatomia/<pacote>.json + .bin. Cada pacote é baixado só quando é pedido.
import * as THREE from 'three';
import { MeshoptDecoder } from '../vendor/meshopt_decoder.module.js';

export const PREFABS = {
  corpo_humano: 'Corpo humano',
  orgaos: 'Órgãos do tronco',
  esqueleto: 'Esqueleto humano',
  coracao: 'Coração humano',
  cerebro: 'Cérebro humano',
  respiratorio: 'Sistema respiratório',
};
export const PREFAB_NAMES = Object.keys(PREFABS);
export const ANATOMY_CREDIT = 'BodyParts3D (DBCLS), CC BY 4.0';

const BASE = new URL('../assets/anatomia/', import.meta.url);
const cache = new Map();

// Baixa (com progresso) e decodifica um pacote. onProgress(0..1, nome, fase)
async function load(name, onProgress) {
  const nome = PREFABS[name];
  onProgress(0, nome, 'Baixando');
  const [meta] = await Promise.all([fetch(new URL(`${name}.json`, BASE)).then((r) => {
    if (!r.ok) throw new Error(`anatomia ${name}: ${r.status}`);
    return r.json();
  }), MeshoptDecoder.ready]);
  const res = await fetch(new URL(`${name}.bin`, BASE));
  if (!res.ok) throw new Error(`anatomia ${name}: ${res.status}`);
  let bin;
  const reader = res.body?.getReader?.();
  if (reader) {
    bin = new Uint8Array(meta.bytes);
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bin.set(value.subarray(0, Math.max(0, meta.bytes - got)), got);
      got += value.length;
      onProgress(Math.min(1, got / meta.bytes) * 0.9, nome, 'Baixando');
    }
  } else {
    bin = new Uint8Array(await res.arrayBuffer());
  }
  onProgress(0.92, nome, 'Montando');
  await new Promise((r) => requestAnimationFrame(r));
  const scale = meta.max.map((x, a) => (x - meta.min[a]) / 65535);
  const slice = ([at, len]) => bin.subarray(at, at + len);
  const partes = meta.grupos.map((gr) => {
    const q = new Uint16Array(gr.v * 4);
    MeshoptDecoder.decodeVertexBuffer(new Uint8Array(q.buffer), gr.v, 8, slice(gr.pos));
    const pos = new Float32Array(gr.v * 3);
    for (let v = 0; v < gr.v; v++) {
      for (let a = 0; a < 3; a++) pos[v * 3 + a] = meta.min[a] + q[v * 4 + a] * scale[a];
    }
    const n8 = new Int8Array(gr.v * 4);
    MeshoptDecoder.decodeVertexBuffer(new Uint8Array(n8.buffer), gr.v, 4, slice(gr.nrm), 'OCTAHEDRAL');
    const nrm = new Float32Array(gr.v * 3);
    for (let v = 0; v < gr.v; v++) {
      const x = n8[v * 4], y = n8[v * 4 + 1], z = n8[v * 4 + 2];
      const l = Math.hypot(x, y, z) || 1;
      nrm[v * 3] = x / l;
      nrm[v * 3 + 1] = y / l;
      nrm[v * 3 + 2] = z / l;
    }
    const idx = new Uint32Array(gr.i);
    MeshoptDecoder.decodeIndexBuffer(new Uint8Array(idx.buffer), gr.i, 4, slice(gr.idx));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(new THREE.BufferAttribute(gr.v > 65535 ? idx : Uint16Array.from(idx), 1));
    return { nome: gr.nome, forma: 'pronta', geo, tam: [1, 1, 1], pos: [0, 0, 0], rot: [0, 0, 0], cor: gr.cor, material: gr.material, giro: 0, orbita: 0 };
  });
  onProgress(1, nome, 'Montando');
  return { nome: meta.nome, partes };
}

// Modelo pronto pelo nome (o pacote fica em memória: pedir de novo é instantâneo)
export async function buildPrefab(name, onProgress = () => {}) {
  if (!PREFABS[name]) return null;
  if (!cache.has(name)) {
    cache.set(name, load(name, onProgress).catch((e) => {
      cache.delete(name);
      throw e;
    }));
  }
  const pack = await cache.get(name);
  return { nome: pack.nome, fonte: ANATOMY_CREDIT, partes: pack.partes.map((p) => ({ ...p })) };
}
