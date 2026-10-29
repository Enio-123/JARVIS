// Modelos 3D prontos do Sketchfab (https://sketchfab.com), baixados com o token da própria pessoa.
// O token fica só neste navegador e só vai para a API do Sketchfab. Todo modelo baixado mostra o autor e
// a licença (as licenças Creative Commons pedem o crédito). Os arquivos ficam guardados no Cache do
// navegador: pedir o mesmo modelo de novo não baixa outra vez.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three-addons/loaders/GLTFLoader.js';
import { mergeGeometries } from '../vendor/three-addons/utils/BufferGeometryUtils.js';
import { unzipSync } from '../vendor/three-addons/libs/fflate.module.js';
import { MeshoptDecoder } from '../vendor/meshopt_decoder.module.js';

const API = 'https://api.sketchfab.com/v3';
export const MODELS_CACHE = 'jarvisvoz-modelos-v1';
const INDEX = 'jarvisvoz.modelos'; // [{ termo, uid, titulo, autor, licenca, url, at }]
const KEEP = 6; // modelos guardados no cache
const LOW = (navigator.deviceMemory || 8) <= 4 || matchMedia('(max-width: 700px)').matches;
const MAX_FACES = LOW ? 150000 : 400000;
const MAX_BYTES = (LOW ? 20 : 40) * 1024 * 1024;
const MAX_TEX = LOW ? 1024 : 2048; // texturas maiores são reduzidas (memória da placa de vídeo)
const MAX_PARTS = LOW ? 40 : 160; // mais que isso, junta as peças de mesma aparência
const WAIT = 20000; // sem resposta nesse tempo, desiste

export class SketchfabError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

// Erro do próprio arquivo (formato, tamanho): vale tentar o próximo resultado da busca
const fileError = (message) => Object.assign(new SketchfabError(message), { file: true });

// Controle de cancelamento: o pedido da pessoa (signal) ou o tempo esgotado
function watch(signal) {
  const ac = new AbortController();
  let timer = 0;
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const w = {
    signal: ac.signal,
    timedOut: false,
    kick() {
      clearTimeout(timer);
      timer = setTimeout(() => { w.timedOut = true; ac.abort(); }, WAIT);
    },
    done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
  w.kick();
  return w;
}

async function api(path, token, signal) {
  const w = watch(signal);
  try {
    let res;
    try {
      res = await fetch(API + path, { headers: token ? { Authorization: `Token ${token}` } : {}, signal: w.signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new SketchfabError(w.timedOut ? 'O Sketchfab demorou demais para responder.' : 'Não consegui falar com o Sketchfab. Verifique a internet.');
    }
    if (res.status === 401 || res.status === 403) throw new SketchfabError('O token do Sketchfab foi recusado. Confira nas configurações.', res.status);
    if (res.status === 429) throw new SketchfabError('O Sketchfab pediu uma pausa. Tente de novo daqui a pouco.', 429);
    if (!res.ok) throw new SketchfabError(`O Sketchfab respondeu com erro ${res.status}.`, res.status);
    return await res.json();
  } finally {
    w.done();
  }
}

// Confere o token (configurações): devolve o nome da conta
export async function checkToken(token) {
  const me = await api('/me', token);
  return me.displayName || me.username || 'sua conta';
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const licenseLabel = (l) => (typeof l === 'string' ? l : l?.label || l?.fullName || l?.slug || '');

function readIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX) || '[]'); } catch { return []; }
}
function writeIndex(list) {
  try { localStorage.setItem(INDEX, JSON.stringify(list)); } catch { /* sem armazenamento */ }
}
const cacheKey = (uid) => new Request(`https://jarvisvoz.local/sketchfab/${uid}`);

async function fromCache(uid) {
  try {
    const res = await (await caches.open(MODELS_CACHE)).match(cacheKey(uid));
    return res ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch { return null; }
}

async function remember(entry, bytes) {
  const list = readIndex().filter((e) => e.uid !== entry.uid && e.termo !== entry.termo);
  list.unshift({ ...entry, at: Date.now() });
  const drop = list.splice(KEEP);
  writeIndex(list);
  try {
    const cache = await caches.open(MODELS_CACHE);
    await cache.put(cacheKey(entry.uid), new Response(bytes));
    for (const e of drop) if (!list.some((x) => x.uid === e.uid)) await cache.delete(cacheKey(e.uid));
  } catch { /* sem Cache API: só não fica guardado */ }
}

export async function clearModels() {
  try { await caches.delete(MODELS_CACHE); } catch { /* sem Cache API */ }
  try { localStorage.removeItem(INDEX); } catch { /* sem armazenamento */ }
}

// Os mais relevantes que dá para baixar e abrir aqui, do mais curtido para o menos
function candidates(results) {
  const ok = (results || []).filter((r) => {
    if (!r?.uid || r.isDownloadable === false || r.isAgeRestricted) return false;
    if (r.faceCount > MAX_FACES) return false;
    const size = r.archives?.glb?.size || r.archives?.gltf?.size;
    return !(size > MAX_BYTES);
  });
  return ok.slice(0, 6).sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
}

async function download(url, onProgress, signal) {
  const w = watch(signal);
  try {
    let res;
    try {
      res = await fetch(url, { signal: w.signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new SketchfabError('O download do modelo falhou. Verifique a internet.');
    }
    if (!res.ok) throw new SketchfabError(`O download do modelo falhou (erro ${res.status}).`, res.status);
    const total = +res.headers.get('content-length') || 0;
    const reader = res.body?.getReader?.();
    if (!reader) return new Uint8Array(await res.arrayBuffer());
    const chunks = [];
    let got = 0;
    for (;;) {
      let step;
      try {
        step = await reader.read();
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new SketchfabError(w.timedOut ? 'O download do modelo parou no meio.' : 'O download do modelo falhou. Verifique a internet.');
      }
      if (step.done) break;
      w.kick();
      chunks.push(step.value);
      got += step.value.length;
      if (got > MAX_BYTES * 1.5) {
        reader.cancel();
        throw fileError('Esse modelo é pesado demais para abrir aqui.');
      }
      if (total) onProgress(Math.min(1, got / total));
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  } finally {
    w.done();
  }
}

// GLB direto, ou o zip do glTF (scene.gltf + scene.bin + texturas)
async function parse(bytes) {
  const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const loader = (manager) => new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!zip) return loader().parseAsync(ab(bytes), '');
  let files;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new SketchfabError('O arquivo do modelo veio corrompido.');
  }
  const names = Object.keys(files).filter((n) => !n.endsWith('/'));
  const main = names.find((n) => /(^|\/)scene\.gltf$/i.test(n)) || names.find((n) => /\.gltf$/i.test(n));
  if (!main) {
    const glb = names.find((n) => /\.glb$/i.test(n));
    if (glb) return loader().parseAsync(ab(files[glb]), '');
    throw new SketchfabError('O arquivo do modelo veio num formato que eu não sei abrir.');
  }
  const base = main.slice(0, main.lastIndexOf('/') + 1);
  const urls = new Map();
  for (const n of names) if (n !== main && n.startsWith(base)) urls.set(n.slice(base.length), URL.createObjectURL(new Blob([files[n]])));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((u) => {
    let key = u.replace(/^\.\//, '');
    try { key = decodeURIComponent(key); } catch { /* nome com % solto */ }
    return urls.get(key) ?? u;
  });
  try {
    return await loader(manager).parseAsync(new TextDecoder().decode(files[main]), '');
  } finally {
    for (const u of urls.values()) URL.revokeObjectURL(u);
  }
}

// ---------- Geometria ----------
const KEEP_ATTRS = ['position', 'normal', 'uv', 'uv1', 'color', 'tangent'];
const GET = ['getX', 'getY', 'getZ', 'getW'];

// Cópia "limpa" da malha: atributos em Float32 (sem intercalação nem quantização), sempre com índice
function plain(src) {
  const geo = new THREE.BufferGeometry();
  for (const k of KEEP_ATTRS) {
    const a = src.attributes[k];
    if (!a) continue;
    const s = a.itemSize;
    const arr = new Float32Array(a.count * s);
    if (!a.isInterleavedBufferAttribute && !a.normalized && a.array.length === arr.length) arr.set(a.array);
    else for (let i = 0; i < a.count; i++) for (let j = 0; j < s; j++) arr[i * s + j] = a[GET[j]](i);
    geo.setAttribute(k, new THREE.BufferAttribute(arr, s));
  }
  const n = src.index ? src.index.count : geo.attributes.position.count;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = src.index ? src.index.getX(i) : i;
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

// Pose atual dos ossos aplicada na malha (personagens com esqueleto)
function bakeSkin(mesh, geo) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    mesh.applyBoneTransform(i, v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.deleteAttribute('normal');
  geo.deleteAttribute('tangent');
}

// Peças do modelo: cada malha (no glTF, uma por material) vira uma peça com a posição já aplicada;
// modelos com peças demais juntam as do mesmo material.
function pieces(scene) {
  scene.updateMatrixWorld(true);
  const list = [];
  scene.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const geo = plain(o.geometry);
    if (!geo.index.count) return;
    if (o.isSkinnedMesh && o.skeleton && o.geometry.attributes.skinIndex) bakeSkin(o, geo);
    geo.applyMatrix4(o.matrixWorld);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    list.push({ geo, mat: Array.isArray(o.material) ? o.material[0] : o.material, name: o.name });
  });
  if (list.length <= MAX_PARTS) return list;
  // junta as peças de mesma aparência (exportadores costumam repetir o mesmo material para cada peça)
  const byMat = new Map();
  for (const p of list) {
    const k = look(p.mat);
    if (!byMat.has(k)) byMat.set(k, []);
    byMat.get(k).push(p);
  }
  const out = [];
  for (const group of byMat.values()) {
    if (group.length === 1) { out.push(group[0]); continue; }
    const common = KEEP_ATTRS.filter((a) => group.every((p) => p.geo.attributes[a]));
    for (const p of group) for (const k of Object.keys(p.geo.attributes)) if (!common.includes(k)) p.geo.deleteAttribute(k);
    const merged = mergeGeometries(group.map((p) => p.geo), false);
    if (merged) out.push({ geo: merged, mat: group[0].mat, name: group[0].mat?.name || group[0].name });
    else out.push(...group);
  }
  return out;
}

const look = (m) => (!m ? 'sem' : [
  m.type, m.name, m.color?.getHexString(), m.emissive?.getHexString(), m.metalness, m.roughness, m.opacity, m.transparent,
  m.alphaTest, m.side, m.vertexColors, m.map?.uuid, m.normalMap?.uuid, m.roughnessMap?.uuid, m.metalnessMap?.uuid,
  m.emissiveMap?.uuid, m.aoMap?.uuid, m.alphaMap?.uuid,
].join('|'));

// Texturas grandes demais viram uma cópia menor (as de 4K pesam 64 MB cada na placa de vídeo).
// Texturas que dividem a mesma imagem recebem a mesma cópia.
function shrinkTextures(parts) {
  const copies = new Map(); // imagem original -> cópia menor (ou ela mesma)
  for (const { mat } of parts) {
    if (!mat) continue;
    for (const tex of Object.values(mat)) {
      const img = tex?.isTexture ? tex.image : null;
      if (!img) continue;
      if (!copies.has(img)) copies.set(img, smaller(img));
      const out = copies.get(img);
      if (out !== img && tex.image !== out) {
        tex.image = out;
        tex.needsUpdate = true;
      }
    }
  }
  for (const [img, out] of copies) if (out !== img) img.close?.();
}

function smaller(img) {
  const w = img.width || 0, h = img.height || 0;
  if (Math.max(w, h) <= MAX_TEX) return img;
  const k = MAX_TEX / Math.max(w, h);
  const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
  try {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cw, ch) : Object.assign(document.createElement('canvas'), { width: cw, height: ch });
    c.getContext('2d').drawImage(img, 0, 0, cw, ch);
    return c;
  } catch {
    return img; // fica a original
  }
}

// Nome legível para a peça ("Cube.001_Material.002_0" -> "Cube"), ou "Peça N"
function partName(raw, i) {
  const s = String(raw || '').replace(/[_.]\d+$/g, '').replace(/[_.](\d+|mat|material|geo|mesh|object)\b.*$/i, '').replace(/[_]+/g, ' ').trim();
  if (!s || /^(object|mesh|node|geometry|default|defaultmaterial|material|root|scene|sketchfab)\b/i.test(s) || s.length > 32) return `Peça ${i + 1}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toModel(gltf, info) {
  const parts = pieces(gltf.scene || gltf.scenes?.[0]);
  if (!parts.length) throw new SketchfabError('O modelo baixado veio vazio.');
  shrinkTextures(parts);
  const seen = new Map();
  const titulo = info.titulo.length > 40 ? `${info.titulo.slice(0, 38).trim()}…` : info.titulo;
  const licenca = info.licenca || 'licença no Sketchfab';
  return {
    nome: info.nome,
    fonte: `"${titulo}" de ${info.autor}, Sketchfab, ${licenca}`,
    credito: `"${info.titulo}" de ${info.autor} (${licenca})`,
    partes: parts.map((p, i) => {
      let nome = partName(p.name || p.mat?.name, i);
      const n = (seen.get(nome) || 0) + 1;
      seen.set(nome, n);
      if (n > 1) nome = `${nome} ${n}`;
      return { nome, forma: 'pronta', geo: p.geo, mat: p.mat, tam: [1, 1, 1], pos: [0, 0, 0], rot: [0, 0, 0], cor: '#ffffff', material: 'pronto', giro: 0, orbita: 0 };
    }),
  };
}

async function open(bytes, info) {
  let gltf;
  try {
    gltf = await parse(bytes);
  } catch (e) {
    console.warn(e);
    throw fileError(e instanceof SketchfabError ? e.message : 'Esse modelo veio num formato que eu não consigo abrir.');
  }
  return toModel(gltf, info);
}

async function fetchModel(r, key, nome, token, onProgress, signal) {
  onProgress(0.05, 'Baixando');
  const [dl, detail] = await Promise.all([
    api(`/models/${r.uid}/download`, token, signal),
    licenseLabel(r.license) ? null : api(`/models/${r.uid}`, null, signal).catch(() => null),
  ]);
  const file = [dl.glb, dl.gltf].find((f) => f?.url && !(f.size > MAX_BYTES));
  if (!file) throw fileError('Esse modelo não tem um arquivo que eu consiga abrir aqui.');
  const bytes = await download(file.url, (k) => onProgress(0.05 + k * 0.9, 'Baixando'), signal);
  onProgress(0.97, 'Abrindo');
  const info = {
    termo: key,
    uid: r.uid,
    titulo: String(r.name || nome).trim(),
    autor: r.user?.displayName || r.user?.username || 'autor desconhecido',
    licenca: licenseLabel(r.license) || licenseLabel(detail?.license),
    url: r.viewerUrl || '',
  };
  const model = await open(bytes, { ...info, nome });
  await remember(info, bytes);
  return model;
}

// Procura, baixa e abre um modelo. onProgress(0..1, fase). Sem resultado, devolve null.
export async function findModel({ termo, nome }, token, onProgress = () => {}, signal) {
  const key = norm(termo);
  const known = readIndex().find((e) => e.termo === key);
  if (known) {
    const bytes = await fromCache(known.uid);
    if (bytes) {
      onProgress(1, 'Abrindo');
      try {
        return await open(bytes, { ...known, nome });
      } catch {
        writeIndex(readIndex().filter((e) => e.uid !== known.uid)); // guardado com defeito: baixa de novo
      }
    }
  }
  onProgress(0, 'Procurando');
  const q = new URLSearchParams({ type: 'models', q: termo, downloadable: 'true', count: '24', archives_flavours: 'false', max_face_count: String(MAX_FACES) });
  const found = await api(`/search?${q}`, null, signal);
  const list = candidates(found.results);
  if (!list.length) return null;
  // se o arquivo do primeiro não abrir, tenta o segundo
  let lastErr = null;
  for (const r of list.slice(0, 2)) {
    try {
      return await fetchModel(r, key, nome, token, onProgress, signal);
    } catch (e) {
      if (!e.file && e.status !== 400 && e.status !== 404) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}
