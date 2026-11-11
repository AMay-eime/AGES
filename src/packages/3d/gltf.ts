// glTF のモデル（.glb。1つにまとまった形）を読む。依存なし。Node でもブラウザでも同じに動く
// （Node では要約 summarizeGlb を地図・ages assets に出し、ブラウザでは描く）。
// 読むもの: メッシュ（位置・法線・UV・番号）、ノードの親子と位置、材質（色・画像・ざらつき・両面・透ける・光を受けない）、
// 画像（中に入っているもの・外のファイル）、動きの名前。骨と動きの中身は animation.ts（これから）
import { composeQuat, identity, multiply, transformPoint, type Mat4, type Vec3 } from './math.ts';

export interface GltfPrimitive {
  /** 頂点ごとに x y z nx ny nz u v（描画の頂点の並びと同じ） */
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
  material: number;
  min: Vec3;
  max: Vec3;
}
export interface GltfMaterial {
  color: [number, number, number, number];
  /** 画像の番号（images）。なければ -1 */
  image: number;
  roughness: number;
  doubleSided: boolean;
  blend: boolean;
  unlit: boolean;
}
export interface GltfImage {
  /** 外のファイル（モデルのあるフォルダから見た場所） */
  uri?: string;
  /** 中に入っている画像 */
  data?: Uint8Array;
  mime?: string;
}
export interface GltfNode { name: string; local: Mat4; world: Mat4; children: number[]; mesh: number }
export interface GltfModel {
  nodes: GltfNode[];
  meshes: GltfPrimitive[][];
  materials: GltfMaterial[];
  images: GltfImage[];
  /** 全体を囲む箱（モデルの座標） */
  min: Vec3;
  max: Vec3;
  tris: number;
  /** 動きの名前 */
  clips: string[];
}

interface Json { [k: string]: any }

/** .glb を JSON とデータに分ける */
export function splitGlb(buf: Uint8Array): { json: Json; bin: Uint8Array } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 20 || v.getUint32(0, true) !== 0x46546c67) throw new Error('.glb ではありません（glTF の1つにまとまった形だけを読めます。.gltf + .bin は、書き出すときに GLB を選んでください）');
  if (v.getUint32(4, true) !== 2) throw new Error(`glTF ${v.getUint32(4, true)} は読めません（2.0 だけ）`);
  let json: Json | null = null;
  let bin: Uint8Array = new Uint8Array(0);
  for (let o = 12; o + 8 <= buf.byteLength;) {
    const len = v.getUint32(o, true), type = v.getUint32(o + 4, true);
    const body = buf.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body)) as Json;
    else if (type === 0x004e4942) bin = body;
    o += 8 + len;
  }
  if (!json) throw new Error('.glb に JSON がありません');
  return { json, bin };
}

const COMPONENTS: Record<number, { size: number; get: (v: DataView, o: number) => number; max: number }> = {
  5120: { size: 1, get: (v, o) => v.getInt8(o), max: 127 },
  5121: { size: 1, get: (v, o) => v.getUint8(o), max: 255 },
  5122: { size: 2, get: (v, o) => v.getInt16(o, true), max: 32767 },
  5123: { size: 2, get: (v, o) => v.getUint16(o, true), max: 65535 },
  5125: { size: 4, get: (v, o) => v.getUint32(o, true), max: 4294967295 },
  5126: { size: 4, get: (v, o) => v.getFloat32(o, true), max: 1 },
};
const WIDTH: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** アクセサの中身を数の並びにする（normalized なら 0〜1 に） */
function readAccessor(json: Json, bin: Uint8Array, index: number): { data: number[]; width: number; count: number } {
  const a = json.accessors?.[index];
  if (!a) throw new Error(`アクセサ ${index} がありません`);
  const c = COMPONENTS[a.componentType], width = WIDTH[a.type];
  if (!c || !width) throw new Error(`アクセサ ${index} の型 ${a.componentType}/${a.type} は読めません`);
  const out = new Array<number>(a.count * width).fill(0);
  if (a.bufferView === undefined) return { data: out, width, count: a.count };
  const bv = json.bufferViews[a.bufferView];
  if ((bv.buffer ?? 0) !== 0 || json.buffers?.[0]?.uri) throw new Error('データが .glb の外にあります（1つにまとまった .glb で書き出してください）');
  const stride = bv.byteStride || c.size * width;
  const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const v = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const k = a.normalized ? 1 / c.max : 1;
  for (let i = 0; i < a.count; i++) for (let j = 0; j < width; j++) out[i * width + j] = c.get(v, start + i * stride + j * c.size) * k;
  return { data: out, width, count: a.count };
}

export function parseGlb(buf: Uint8Array): GltfModel {
  const { json, bin } = splitGlb(buf);
  const materials: GltfMaterial[] = (json.materials ?? []).map((m: Json): GltfMaterial => {
    const pbr = m.pbrMetallicRoughness ?? {};
    const tex = pbr.baseColorTexture ? json.textures?.[pbr.baseColorTexture.index] : null;
    return {
      color: (pbr.baseColorFactor ?? [1, 1, 1, 1]) as [number, number, number, number],
      image: tex && tex.source !== undefined ? tex.source : -1,
      roughness: pbr.roughnessFactor ?? 1,
      doubleSided: !!m.doubleSided,
      blend: m.alphaMode === 'BLEND',
      unlit: !!m.extensions?.KHR_materials_unlit,
    };
  });
  // 材質のない面のための既定の材質（最後に足す）
  const fallback = materials.length;
  materials.push({ color: [1, 1, 1, 1], image: -1, roughness: 1, doubleSided: false, blend: false, unlit: false });
  const images: GltfImage[] = (json.images ?? []).map((im: Json): GltfImage => {
    if (im.bufferView !== undefined) {
      const bv = json.bufferViews[im.bufferView];
      return { data: bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength), mime: im.mimeType ?? 'image/png' };
    }
    return { uri: typeof im.uri === 'string' ? im.uri : '' };
  });
  let tris = 0;
  const meshes: GltfPrimitive[][] = (json.meshes ?? []).map((mesh: Json) => (mesh.primitives ?? []).flatMap((p: Json): GltfPrimitive[] => {
    if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) return []; // 三角形だけ
    const pos = readAccessor(json, bin, p.attributes.POSITION);
    const nor = p.attributes.NORMAL !== undefined ? readAccessor(json, bin, p.attributes.NORMAL).data : null;
    const uv = p.attributes.TEXCOORD_0 !== undefined ? readAccessor(json, bin, p.attributes.TEXCOORD_0).data : null;
    const idx = p.indices !== undefined ? readAccessor(json, bin, p.indices).data : Array.from({ length: pos.count }, (_, i) => i);
    const normals = nor ?? flatNormals(pos.data, idx);
    const vertices = new Float32Array(pos.count * 8);
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.count; i++) {
      for (let k = 0; k < 3; k++) {
        const v = pos.data[i * 3 + k];
        vertices[i * 8 + k] = v;
        vertices[i * 8 + 3 + k] = normals[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
      if (uv) { vertices[i * 8 + 6] = uv[i * 2]; vertices[i * 8 + 7] = uv[i * 2 + 1]; }
    }
    tris += Math.floor(idx.length / 3);
    return [{ vertices, indices: pos.count > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), material: p.material ?? fallback, min, max }];
  }));
  // ノード（親から子へ、世界の行列を求める）
  const nodes: GltfNode[] = (json.nodes ?? []).map((n: Json): GltfNode => ({
    name: n.name ?? '',
    local: n.matrix ? [...n.matrix] : composeQuat(n.translation ?? [0, 0, 0], n.rotation ?? [0, 0, 0, 1], n.scale ?? [1, 1, 1]),
    world: identity(),
    children: n.children ?? [],
    mesh: n.mesh ?? -1,
  }));
  const scene = json.scenes?.[json.scene ?? 0];
  const child = new Set(nodes.flatMap((n) => n.children));
  const roots: number[] = scene?.nodes ?? nodes.map((_, i) => i).filter((i) => !child.has(i));
  const walk = (i: number, parent: Mat4, depth: number) => {
    const n = nodes[i];
    if (!n || depth > 64) return;
    n.world = multiply(parent, n.local);
    for (const c of n.children) walk(c, n.world, depth + 1);
  };
  for (const r of roots) walk(r, identity(), 0);
  // 全体を囲む箱
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const n of nodes) {
    for (const p of meshes[n.mesh] ?? []) {
      for (let c = 0; c < 8; c++) {
        const q = transformPoint(n.world, [c & 1 ? p.max[0] : p.min[0], c & 2 ? p.max[1] : p.min[1], c & 4 ? p.max[2] : p.min[2]]);
        for (let k = 0; k < 3; k++) { if (q[k] < min[k]) min[k] = q[k]; if (q[k] > max[k]) max[k] = q[k]; }
      }
    }
  }
  if (!Number.isFinite(min[0])) { min.fill(0); max.fill(0); }
  return { nodes, meshes, materials, images, min, max, tris, clips: (json.animations ?? []).map((a: Json, i: number) => a.name ?? `clip${i}`) };
}

/** 法線のないメッシュ: 面ごとの向きを頂点に足して平均する */
function flatNormals(pos: number[], idx: number[]): number[] {
  const n = new Array<number>(pos.length).fill(0);
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const f = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    for (const o of [a, b, c]) for (let k = 0; k < 3; k++) n[o + k] += f[k];
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000 || 0;

/** モデルの要約（大きさ m・中心・三角形の数・動きの名前）。地図・ages assets に出す */
export function summarizeGlb(buf: Uint8Array): { size: [number, number, number]; center: [number, number, number]; tris: number; clips: string[] } {
  const m = parseGlb(buf);
  return {
    size: [r3(m.max[0] - m.min[0]), r3(m.max[1] - m.min[1]), r3(m.max[2] - m.min[2])],
    center: [r3((m.max[0] + m.min[0]) / 2), r3((m.max[1] + m.min[1]) / 2), r3((m.max[2] + m.min[2]) / 2)],
    tris: m.tris,
    clips: m.clips,
  };
}
