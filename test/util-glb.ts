// テスト用: 小さな .glb を作る（箱1つ。ノードの位置・倍率、材質の色、中に入れた画像、動きの名前）
import { box } from '../src/packages/3d/geometry.ts';

/** 1x1 の PNG（色は rgba） */
export function png1x1(rgba: [number, number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const raw = new Uint8Array([0, ...rgba]);
  // 圧縮なしの zlib（stored）
  const adler = (() => { let a = 1, b = 0; for (const x of raw) { a = (a + x) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; })();
  const z = new Uint8Array([0x78, 0x01, 0x01, raw.length, 0, ~raw.length & 255, 255, ...raw, adler >>> 24, (adler >>> 16) & 255, (adler >>> 8) & 255, adler & 255]);
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1); new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export interface GlbOptions {
  /** 材質の色（rgba 0〜1） */
  color?: [number, number, number, number];
  unlit?: boolean;
  /** 中に入れる画像（PNG） */
  image?: Uint8Array;
  translation?: [number, number, number];
  scale?: [number, number, number];
  clips?: string[];
  /** 骨2本（下半分は骨0、上半分は骨1）と、動き bend（骨1 が z 軸まわりに 1秒で 90度）・slide（骨0 が 1秒で x へ 2m） */
  skinned?: boolean;
}

/** 1m の箱のモデル */
export function makeGlb(o: GlbOptions = {}): Uint8Array {
  const g = box();
  const n = g.vertices.length / 8;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { pos.set(g.vertices.subarray(i * 8, i * 8 + 3), i * 3); nor.set(g.vertices.subarray(i * 8 + 3, i * 8 + 6), i * 3); uv.set(g.vertices.subarray(i * 8 + 6, i * 8 + 8), i * 2); }
  const chunks: Uint8Array[] = [new Uint8Array(pos.buffer), new Uint8Array(nor.buffer), new Uint8Array(uv.buffer), new Uint8Array(g.indices.buffer)];
  if (o.image) chunks.push(o.image);
  const base = chunks.length;
  if (o.skinned) {
    const joints = new Uint8Array(n * 4), weights = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { joints[i * 4] = pos[i * 3 + 1] > 0 ? 1 : 0; weights[i * 4] = 1; }
    const ibm = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const h = Math.SQRT1_2;
    chunks.push(joints, new Uint8Array(weights.buffer), new Uint8Array(ibm.buffer), new Uint8Array(new Float32Array([0, 1]).buffer), new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, h, h]).buffer), new Uint8Array(new Float32Array([0, -0.5, 0, 2, -0.5, 0]).buffer));
  }
  const views: { buffer: 0; byteOffset: number; byteLength: number }[] = [];
  let off = 0;
  for (const c of chunks) { views.push({ buffer: 0, byteOffset: off, byteLength: c.length }); off += Math.ceil(c.length / 4) * 4; }
  const bin = new Uint8Array(off);
  chunks.forEach((c, i) => bin.set(c, views[i].byteOffset));
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: o.skinned ? [0, 1] : [0] }],
    nodes: [{ name: 'box', mesh: 0, ...(o.skinned ? { skin: 0 } : {}), ...(o.translation ? { translation: o.translation } : {}), ...(o.scale ? { scale: o.scale } : {}) },
      ...(o.skinned ? [{ name: 'lower', translation: [0, -0.5, 0], children: [2] }, { name: 'upper', translation: [0, 0.5, 0] }] : [])],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, ...(o.skinned ? { JOINTS_0: 4, WEIGHTS_0: 5 } : {}) }, indices: 3, material: 0 }] }],
    ...(o.skinned ? {
      skins: [{ joints: [1, 2], inverseBindMatrices: 6 }],
      animations: [
        { name: 'bend', channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }], samplers: [{ input: 7, output: 8, interpolation: 'LINEAR' }] },
        { name: 'slide', channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }], samplers: [{ input: 7, output: 9 }] },
      ],
    } : {}),
    materials: [{ pbrMetallicRoughness: { baseColorFactor: o.color ?? [1, 1, 1, 1], ...(o.image ? { baseColorTexture: { index: 0 } } : {}) }, ...(o.unlit ? { extensions: { KHR_materials_unlit: {} } } : {}) }],
    ...(o.image ? { textures: [{ source: 0 }], images: [{ bufferView: 4, mimeType: 'image/png' }] } : {}),
    ...(o.clips ? { animations: o.clips.map((name) => ({ name, channels: [], samplers: [] })) } : {}),
    accessors: [
      { bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: n, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: n, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: g.indices.length, type: 'SCALAR' },
      ...(o.skinned ? [
        { bufferView: base, componentType: 5121, count: n, type: 'VEC4' },
        { bufferView: base + 1, componentType: 5126, count: n, type: 'VEC4' },
        { bufferView: base + 2, componentType: 5126, count: 2, type: 'MAT4' },
        { bufferView: base + 3, componentType: 5126, count: 2, type: 'SCALAR' },
        { bufferView: base + 4, componentType: 5126, count: 2, type: 'VEC4' },
        { bufferView: base + 5, componentType: 5126, count: 2, type: 'VEC3' },
      ] : []),
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  let text = JSON.stringify(json);
  while (new TextEncoder().encode(text).length % 4) text += ' ';
  const jb = new TextEncoder().encode(text);
  const out = new Uint8Array(12 + 8 + jb.length + 8 + bin.length), v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, out.length, true);
  v.setUint32(12, jb.length, true); v.setUint32(16, 0x4e4f534a, true); out.set(jb, 20);
  v.setUint32(20 + jb.length, bin.length, true); v.setUint32(24 + jb.length, 0x004e4942, true); out.set(bin, 28 + jb.length);
  return out;
}
