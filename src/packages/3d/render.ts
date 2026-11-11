// 3D の描画（WebGL2）。2D の描画の下の層（src/render/layer.ts）として、背景の上・2D の物の下に描く。
// - 自分の描く先（色 + 奥行き。4倍のアンチエイリアス）に描いてから、2D の描く先へ重ねる（2D 側に奥行きの用意がなくてよい）
// - 光: 太陽1つ + 点の光8つまで + 全体の明るさ（上と下の色）
// - 影: 太陽の影だけ（影の地図1枚。カメラから shadowRange m まで。先に光から見た奥行きを描き、本番で比べる）
// - 色は画面の色のまま計算する（2D の色と同じに見えるように。光の計算を直線の色で行うのは、必要になってから）
import type { LayerFrame, LayerHost, RenderLayer } from '../../render/layer.ts';
import { box, capsule, cylinder, plane, sphere, type Geometry } from './geometry.ts';
import { cross, invert, multiply, normalize, orthographic, transformDirection, transformPoint, type Mat4, type Vec3 } from './math.ts';
import { cameraOf, matrixOf, type CameraView3 } from './space.ts';
import { parseGlb, type GltfModel } from './gltf.ts';
import { jointMatrices, modelPose } from './animation.ts';
import { translation } from './math.ts';

const MAX_POINT = 8;
/** 影の地図の1辺（画素） */
const SHADOW_SIZE = 2048;

const VS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_normal;
layout(location=2) in vec2 a_uv;
layout(location=3) in vec4 a_joints;
layout(location=4) in vec4 a_weights;
uniform sampler2D u_jointTex;
uniform float u_skin;
uniform mat4 u_viewProj;
uniform mat4 u_model;
uniform mat3 u_normalMat;
uniform vec2 u_tile;
out vec3 v_world;
out vec3 v_normal;
out vec2 v_uv;
mat4 joint(float j) {
  int y = int(j);
  return mat4(texelFetch(u_jointTex, ivec2(0, y), 0), texelFetch(u_jointTex, ivec2(1, y), 0), texelFetch(u_jointTex, ivec2(2, y), 0), texelFetch(u_jointTex, ivec2(3, y), 0));
}
void main() {
  vec4 p = vec4(a_pos, 1.0);
  vec3 nrm = a_normal;
  if (u_skin > 0.5) {
    // 骨で動かす（モデルの座標の中で）
    mat4 sk = joint(a_joints.x) * a_weights.x + joint(a_joints.y) * a_weights.y + joint(a_joints.z) * a_weights.z + joint(a_joints.w) * a_weights.w;
    p = sk * p;
    nrm = mat3(sk) * nrm;
  }
  vec4 w = u_model * p;
  v_world = w.xyz;
  v_normal = u_normalMat * nrm;
  v_uv = a_uv * u_tile;
  gl_Position = u_viewProj * w;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_world;
in vec3 v_normal;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec4 u_color;
uniform float u_unlit;
uniform float u_roughness;
uniform vec3 u_camPos;
uniform vec3 u_sky;
uniform vec3 u_ground;
uniform vec3 u_sunDir;
uniform vec3 u_sunColor;
uniform int u_pointCount;
uniform vec3 u_pointPos[${MAX_POINT}];
uniform vec3 u_pointColor[${MAX_POINT}];
uniform float u_pointRange[${MAX_POINT}];
uniform vec4 u_fog; // 色は u_fogColor、x=始まり y=終わり z=使うか
uniform vec3 u_fogColor;
uniform highp sampler2DShadow u_shadowMap;
uniform mat4 u_shadowMat; // 世界 → 影の地図（0〜1）
uniform vec4 u_shadow; // x=使うか y=面の向きへずらす量(m) z=影の届く距離(m) w=1画素の幅(0〜1)
uniform vec3 u_camDir;
out vec4 o_color;
// 太陽が届く割合（1 = 日なた、0 = 影）。まわり9点をならして、ふちをやわらかくする
float sunlit(vec3 n) {
  if (u_shadow.x < 0.5) return 1.0;
  vec3 p = (u_shadowMat * vec4(v_world + n * u_shadow.y, 1.0)).xyz;
  if (p.x <= 0.0 || p.x >= 1.0 || p.y <= 0.0 || p.y >= 1.0 || p.z >= 1.0) return 1.0;
  float sum = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) sum += texture(u_shadowMap, vec3(p.xy + vec2(float(x), float(y)) * u_shadow.w, p.z));
  // 届く距離の手前から、だんだん影をなくす
  float far = dot(v_world - u_camPos, u_camDir);
  return mix(sum / 9.0, 1.0, smoothstep(u_shadow.z * 0.8, u_shadow.z, far));
}
void main() {
  vec4 base = texture(u_tex, v_uv) * u_color;
  vec3 rgb = base.rgb;
  if (u_unlit < 0.5) {
    vec3 n = normalize(v_normal);
    if (!gl_FrontFacing) n = -n;
    vec3 toCam = normalize(u_camPos - v_world);
    float shine = mix(96.0, 6.0, u_roughness);
    float gloss = (1.0 - u_roughness) * 0.6;
    vec3 light = mix(u_ground, u_sky, n.y * 0.5 + 0.5);
    vec3 spec = vec3(0.0);
    float d = max(dot(n, -u_sunDir), 0.0);
    if (d > 0.0) d *= sunlit(n);
    light += u_sunColor * d;
    if (d > 0.0) spec += u_sunColor * pow(max(dot(n, normalize(toCam - u_sunDir)), 0.0), shine) * gloss;
    for (int i = 0; i < ${MAX_POINT}; i++) {
      if (i >= u_pointCount) break;
      vec3 to = u_pointPos[i] - v_world;
      float dist = length(to);
      vec3 l = to / max(dist, 0.0001);
      float fall = clamp(1.0 - (dist * dist) / (u_pointRange[i] * u_pointRange[i]), 0.0, 1.0);
      fall *= fall;
      float pd = max(dot(n, l), 0.0) * fall;
      light += u_pointColor[i] * pd;
      if (pd > 0.0) spec += u_pointColor[i] * pow(max(dot(n, normalize(toCam + l)), 0.0), shine) * gloss * fall;
    }
    rgb = rgb * light + spec;
  }
  if (u_fog.z > 0.5) {
    float f = clamp((distance(u_camPos, v_world) - u_fog.x) / max(u_fog.y - u_fog.x, 0.0001), 0.0, 1.0);
    rgb = mix(rgb, u_fogColor, f);
  }
  // 重ねるときのために、色に不透明度をかけておく
  o_color = vec4(rgb * base.a, base.a);
}`;

/** 影の地図に描くとき（奥行きだけ） */
const DEPTH_FS = `#version 300 es
precision mediump float;
void main() {}`;

const BLIT_VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const BLIT_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 o_color;
void main() { o_color = texture(u_tex, v_uv); }`;

interface Mesh { vao: WebGLVertexArrayObject; count: number; type: number }
/** 描くときの材質 */
interface Mat { color: [number, number, number, number]; tex: WebGLTexture; tile: [number, number]; roughness: number; unlit: boolean; doubleSided: boolean }
/** 読み込んだモデル（ノードごとのメッシュと材質） */
interface Model {
  parts: { node: number; world: Mat4; mesh: Mesh; material: number; skinned: boolean }[];
  /** 動き・骨を求めるための元のデータ */
  gltf: GltfModel;
  materials: { color: [number, number, number, number]; tex: WebGLTexture; roughness: number; unlit: boolean; doubleSided: boolean; blend: boolean }[];
  center: Vec3;
  size: Vec3;
}
interface Tex { tex: WebGLTexture; loaded: Promise<void> }
/** 1回の描画で描く物 */
interface Item { m: Mat4; mesh: Mesh; mat: Mat; depth: number; clear: boolean; cast: boolean; joints?: Float32Array }
interface Lights { sun: { dir: Vec3; color: Vec3; shadow: boolean; range: number } | null; pos: number[]; col: number[]; range: number[]; env: Record<string, any> | undefined }

/** 3D の層への指示（DrawOptions.layers['3d']） */
export interface Layer3DOptions {
  /** ゲームのカメラの代わりに、この視点で描く（エディタの自由な視点） */
  camera?: CameraView3;
  /** 地面（y = 0）に 1m の格子を描く（エディタ）。center のまわり half m */
  grid?: { center: Vec3; half: number };
}

/** 描いた物（クリックで選ぶ・AI の確かめに使う） */
export interface Drawn3D { id: string; matrix: Mat4; shape: string; size: Vec3 }

export class Layer3D implements RenderLayer {
  readonly name = '3d';
  draws = 0;
  /** 前の draw で使ったカメラと、描いた物 */
  camera: CameraView3 | null = null;
  drawn: Drawn3D[] = [];
  private gl: WebGL2RenderingContext;
  private host: LayerHost;
  private prog: WebGLProgram;
  private blit: WebGLProgram;
  private depthProg: WebGLProgram;
  private loc = new Map<string, WebGLUniformLocation | null>();
  private depthLoc = new Map<string, WebGLUniformLocation | null>();
  // 影の地図（太陽から見た奥行き）。使うときに作る。使わないときは 1画素の代わりを当てる
  private shadowTex: WebGLTexture | null = null;
  private shadowFbo: WebGLFramebuffer | null = null;
  private noShadow: WebGLTexture;
  private meshes = new Map<string, Mesh>();
  private textures = new Map<string, Tex>();
  private white: WebGLTexture;
  private emptyVao: WebGLVertexArrayObject;
  // 描く先（大きさが変わったら作り直す）
  private size = { w: 0, h: 0 };
  private msaa: WebGLFramebuffer | null = null;
  private resolve: WebGLFramebuffer | null = null;
  private color: WebGLTexture | null = null;
  private buffers: WebGLRenderbuffer[] = [];

  constructor(host: LayerHost) {
    this.host = host;
    const gl = (this.gl = host.gl);
    this.prog = program(gl, VS, FS);
    this.blit = program(gl, BLIT_VS, BLIT_FS);
    this.depthProg = program(gl, VS, DEPTH_FS);
    this.noShadow = this.depthTexture(1);
    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    this.emptyVao = gl.createVertexArray()!;
  }

  private u(name: string): WebGLUniformLocation | null {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.loc.get(name)!;
  }

  private ud(name: string): WebGLUniformLocation | null {
    if (!this.depthLoc.has(name)) this.depthLoc.set(name, this.gl.getUniformLocation(this.depthProg, name));
    return this.depthLoc.get(name)!;
  }

  /** 奥行きの画像（比べた結果をならして読む） */
  private depthTexture(size: number): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    return t;
  }

  /**
   * 影の地図を描く。カメラの見える範囲（手前から range m まで）を囲む球を、太陽の向きから見下ろす。
   * 戻り値は 世界 → 影の地図（0〜1）の行列と、1画素の幅（m）
   */
  private shadowPass(items: Item[], cam: CameraView3, dir: Vec3, range: number): { mat: Mat4; texel: number } | null {
    const casters = items.filter((x) => x.cast);
    if (!casters.length) return null;
    const gl = this.gl;
    // 見える範囲の8つの角（遠い側は range まで）
    const t = Math.max(0, Math.min(1, (range - cam.near) / Math.max(0.0001, cam.far - cam.near)));
    const pts: Vec3[] = [];
    for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const a = transformPoint(cam.inverse, [x, y, -1]), b = transformPoint(cam.inverse, [x, y, 1]);
      pts.push(a, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
    const c: Vec3 = [0, 0, 0];
    for (const q of pts) { c[0] += q[0] / 8; c[1] += q[1] / 8; c[2] += q[2] / 8; }
    // 半径は切り上げておく（カメラが回っても地図の大きさが変わらず、影のふちがちらつかない）
    const r = Math.max(1, Math.ceil(Math.max(...pts.map((q) => Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]))) * 2) / 2);
    // 光から見た右・上（右 × 上 = 手前。面の表裏が本番と同じになる向き）
    const right = normalize(cross(dir, Math.abs(dir[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0])), up = cross(right, dir);
    // 中心を地図の画素に合わせる（カメラが動いても影のふちが泳がない）
    const texel = (2 * r) / SHADOW_SIZE;
    const snap = (axis: Vec3) => Math.round((c[0] * axis[0] + c[1] * axis[1] + c[2] * axis[2]) / texel) * texel;
    const cx = snap(right), cy = snap(up), cz = c[0] * dir[0] + c[1] * dir[1] + c[2] * dir[2];
    // 範囲の外（太陽の側）にある物の影も落ちるよう、手前に余裕をとる
    const back = r + 100, depth = back + r;
    const eye: Vec3 = [right[0] * cx + up[0] * cy + dir[0] * (cz - back), right[1] * cx + up[1] * cy + dir[1] * (cz - back), right[2] * cx + up[2] * cy + dir[2] * (cz - back)];
    const view = invert([right[0], right[1], right[2], 0, up[0], up[1], up[2], 0, -dir[0], -dir[1], -dir[2], 0, eye[0], eye[1], eye[2], 1]);
    if (!view) return null;
    const viewProj = multiply(orthographic(r, 1, 0, depth), view);

    if (!this.shadowTex) {
      this.shadowTex = this.depthTexture(SHADOW_SIZE);
      this.shadowFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
    }
    // 本番で影の地図を当てる場所（2番）から外しておく（描く先と読む先が同じにならないように）
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.noShadow);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    // 面が自分の影で縞にならないよう、少し奥へずらして描く
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2, 4);
    gl.useProgram(this.depthProg);
    gl.uniformMatrix4fv(this.ud('u_viewProj'), false, new Float32Array(viewProj));
    gl.uniform1i(this.ud('u_jointTex'), 1);
    for (const x of casters) {
      gl.uniform1f(this.ud('u_skin'), x.joints ? 1 : 0);
      if (x.joints) this.bindJoints(x.joints);
      gl.uniformMatrix4fv(this.ud('u_model'), false, new Float32Array(x.m));
      if (x.mat.doubleSided) gl.disable(gl.CULL_FACE); else { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); }
      gl.bindVertexArray(x.mesh.vao);
      gl.drawElements(gl.TRIANGLES, x.mesh.count, x.mesh.type, 0);
      this.draws++;
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindVertexArray(null);
    // -1〜1 を 0〜1 へ
    return { mat: multiply([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0.5, 0.5, 0.5, 1], viewProj), texel };
  }

  private mesh(key: string, make: () => Geometry): Mesh {
    let m = this.meshes.get(key);
    if (m) return m;
    const gl = this.gl;
    // カプセルは大きさごとに作るので、増えすぎたら捨てる
    if (this.meshes.size > 200) { for (const x of this.meshes.values()) gl.deleteVertexArray(x.vao); this.meshes.clear(); }
    m = this.upload(make());
    this.meshes.set(key, m);
    return m;
  }

  /** 頂点（x y z nx ny nz u v）と番号を GPU に送る */
  private upload(g: { vertices: Float32Array; indices: Uint16Array | Uint32Array; skin?: Float32Array }): Mesh {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, g.vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
    for (const [i, n, o] of [[0, 3, 0], [1, 3, 3], [2, 2, 6]]) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, 32, o * 4); }
    if (g.skin) {
      // 骨の番号と重み（別のバッファ）
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, g.skin, gl.STATIC_DRAW);
      for (const [i, o] of [[3, 0], [4, 4]]) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 32, o * 4); }
    }
    gl.bindVertexArray(null);
    return { vao, count: g.indices.length, type: g.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  }

  private models = new Map<string, { model: Model | null; loaded: Promise<void>; error?: string }>();
  /** モデル（.glb）。読み込み中・読めなかったときは null */
  private model(path: string): Model | null {
    let entry = this.models.get(path);
    if (!entry) {
      const e: { model: Model | null; loaded: Promise<void>; error?: string } = { model: null, loaded: Promise.resolve() };
      e.loaded = fetch(this.host.urlOf(path)).then((r) => { if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.arrayBuffer(); }).then((buf) => {
        const g = parseGlb(new Uint8Array(buf));
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
        const texOf = (i: number): WebGLTexture => {
          const im = g.images[i];
          if (!im) return this.white;
          if (im.data) return this.texture(`${path}#${i}`, URL.createObjectURL(new Blob([im.data as BlobPart], { type: im.mime ?? 'image/png' })));
          return im.uri && !im.uri.startsWith('data:') ? this.texture(normalizePath(dir + decodeURIComponent(im.uri))) : im.uri ? this.texture(`${path}#${i}`, im.uri) : this.white;
        };
        const meshes = g.meshes.map((prims) => prims.map((pr) => ({ mesh: this.upload(pr), material: pr.material, skinned: !!pr.skin })));
        e.model = {
          gltf: g,
          parts: g.nodes.flatMap((n, node) => (meshes[n.mesh] ?? []).map((x) => ({ node, world: n.world, ...x, skinned: x.skinned && n.skin >= 0 }))),
          materials: g.materials.map((m) => ({ color: m.color, tex: texOf(m.image), roughness: m.roughness, unlit: m.unlit, doubleSided: m.doubleSided, blend: m.blend })),
          center: [(g.min[0] + g.max[0]) / 2, (g.min[1] + g.max[1]) / 2, (g.min[2] + g.max[2]) / 2],
          size: [g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2] - g.min[2]],
        };
      }).catch((err) => { e.error = (err as Error).message; console.error(`3D のモデル ${path} を読めません: ${e.error}`); });
      this.models.set(path, e);
      entry = e;
    }
    return entry.model;
  }

  private shape(shape: string, size: Vec3): { mesh: Mesh; scale: Vec3 } {
    switch (shape) {
      case 'sphere': return { mesh: this.mesh('sphere', sphere), scale: [size[0], size[0], size[0]] };
      case 'cylinder': return { mesh: this.mesh('cylinder', cylinder), scale: [size[0], size[1], size[0]] };
      case 'plane': return { mesh: this.mesh('plane', plane), scale: [size[0], 1, size[2]] };
      case 'capsule': {
        const d = Math.max(0.001, size[0]), hgt = Math.max(d, size[1]);
        return { mesh: this.mesh(`capsule:${d.toFixed(3)}:${hgt.toFixed(3)}`, () => capsule(d, hgt)), scale: [1, 1, 1] };
      }
      default: return { mesh: this.mesh('box', box), scale: size };
    }
  }

  private texture(path: string, src?: string): WebGLTexture {
    if (!path) return this.white;
    let t = this.textures.get(path);
    if (!t) {
      const gl = this.gl, tex = gl.createTexture()!;
      // 読み込むまでは白
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      const img = new Image();
      const loaded = new Promise<void>((done) => {
        img.onload = () => {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          done();
        };
        img.onerror = () => done();
      });
      img.src = src ?? this.host.urlOf(path);
      t = { tex, loaded };
      this.textures.set(path, t);
    }
    return t.tex;
  }

  invalidate(path?: string): void {
    for (const [k, t] of this.textures) if (!path || k === path || k.startsWith(`${path}#`)) { this.gl.deleteTexture(t.tex); this.textures.delete(k); }
    for (const k of [...this.models.keys()]) if (!path || k === path) this.models.delete(k);
  }

  async settled(): Promise<void> {
    // モデルを読み終わると、その画像の読み込みが始まるので、増えなくなるまで待つ
    for (let i = 0; i < 4; i++) {
      const n = this.models.size + this.textures.size;
      await Promise.all([...[...this.models.values()].map((m) => m.loaded), ...[...this.textures.values()].map((t) => t.loaded)]);
      if (this.models.size + this.textures.size === n) return;
    }
  }

  /** 描く先を用意する（大きさが変わったら作り直す） */
  private target(w: number, h: number): void {
    if (this.size.w === w && this.size.h === h && this.msaa) return;
    const gl = this.gl;
    for (const b of this.buffers) gl.deleteRenderbuffer(b);
    if (this.color) gl.deleteTexture(this.color);
    if (this.msaa) gl.deleteFramebuffer(this.msaa);
    if (this.resolve) gl.deleteFramebuffer(this.resolve);
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
    const rb = (format: number) => {
      const b = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, b);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, format, w, h);
      return b;
    };
    const c = rb(gl.RGBA8), d = rb(gl.DEPTH_COMPONENT24);
    this.buffers = [c, d];
    this.msaa = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaa);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, c);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, d);
    this.color = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.color);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.resolve = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.resolve);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.color, 0);
    this.size = { w, h };
  }

  draw(f: LayerFrame): void {
    this.draws = 0;
    this.drawn = [];
    const world = f.world;
    const opts = (f.options ?? {}) as Layer3DOptions;
    const cam = (this.camera = opts.camera ?? cameraOf(world, f.width / Math.max(1, f.height)));
    // 描く物（見えるもの）。なければ何もしない（3D を入れていても 2D だけのシーンは、そのまま）
    const items: Item[] = [];
    for (const e of world.entities.values()) {
      const c = e.c.Mesh3D as Record<string, any> | undefined;
      const md = e.c.Model3D as Record<string, any> | undefined;
      if (!(c && c.visible !== false) && !(md && md.visible !== false && md.model)) continue;
      const wm = matrixOf(world, e);
      if (!wm) continue;
      const depth = (wm[12] - cam.pos[0]) * cam.dir[0] + (wm[13] - cam.pos[1]) * cam.dir[1] + (wm[14] - cam.pos[2]) * cam.dir[2];
      if (c && c.visible !== false) {
        const size = (c.size ?? [1, 1, 1]) as Vec3;
        const { mesh, scale } = this.shape(c.shape, size);
        const m = multiply(wm, [scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, 0, 0, 0, 1]);
        const [r, g, b] = rgb(c.color ?? '#ffffff'), a = alphaOf(c.color) * (c.alpha ?? 1);
        items.push({ m, mesh, depth, clear: a < 1, cast: c.shadow !== false && a >= 0.5, mat: { color: [r, g, b, a], tex: this.texture(c.texture ?? ''), tile: (c.tile ?? [1, 1]) as [number, number], roughness: c.roughness ?? 0.8, unlit: !!c.unlit, doubleSided: false } });
        this.drawn.push({ id: e.id, matrix: wm, shape: c.shape ?? 'box', size });
      }
      if (md && md.visible !== false && md.model) {
        const model = this.model(md.model);
        if (!model) continue;
        const [r, g, b] = rgb(md.color ?? '#ffffff'), a = alphaOf(md.color) * (md.alpha ?? 1);
        // 動き（clip）・骨があれば、いまの姿勢のノードの行列を求める
        const pose = model.gltf.animations.length || model.gltf.skins.length ? modelPose(model.gltf, md) : null;
        const joints = new Map<number, Float32Array>();
        for (const part of model.parts) {
          const mt = model.materials[part.material] ?? model.materials[model.materials.length - 1];
          const alpha = mt.color[3] * a;
          let jm: Float32Array | undefined;
          if (part.skinned && pose) {
            const sk = model.gltf.nodes[part.node].skin;
            jm = joints.get(sk) ?? jointMatrices(model.gltf, sk, pose);
            joints.set(sk, jm);
          }
          // 骨で動くメッシュは、ノードの位置を使わない（骨の行列に入っている）
          items.push({ m: jm ? wm : multiply(wm, pose?.[part.node] ?? part.world), ...(jm ? { joints: jm } : {}), mesh: part.mesh, depth, clear: alpha < 1 || mt.blend, cast: md.shadow !== false && alpha >= 0.5, mat: { color: [mt.color[0] * r, mt.color[1] * g, mt.color[2] * b, alpha], tex: mt.tex, tile: [1, 1], roughness: mt.roughness, unlit: mt.unlit, doubleSided: mt.doubleSided } });
        }
        // 選ぶ・枠のための、全体を囲む箱
        this.drawn.push({ id: e.id, matrix: multiply(wm, translation(model.center)), shape: 'box', size: model.size });
      }
    }
    if (!items.length && !opts.grid) return;

    const gl = this.gl, W = f.width, H = f.height;
    const L = this.findLights(world);
    // 太陽の影（先に、光から見た奥行きを描く）
    const shadow = L.sun?.shadow ? this.shadowPass(items, cam, L.sun.dir, L.sun.range) : null;
    this.target(W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaa);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u('u_viewProj'), false, new Float32Array(cam.viewProj));
    gl.uniform3fv(this.u('u_camPos'), cam.pos);
    gl.uniform3fv(this.u('u_camDir'), cam.dir);
    this.lights(L, f.background);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, shadow ? this.shadowTex : this.noShadow);
    gl.uniform1i(this.u('u_shadowMap'), 2);
    gl.uniform4f(this.u('u_shadow'), shadow ? 1 : 0, (shadow?.texel ?? 0) * 1.5, L.sun?.range ?? 0, 1 / SHADOW_SIZE);
    if (shadow) gl.uniformMatrix4fv(this.u('u_shadowMat'), false, new Float32Array(shadow.mat));
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.u('u_tex'), 0);
    gl.uniform1i(this.u('u_jointTex'), 1);
    gl.uniform1f(this.u('u_skin'), 0);

    // 透けない物を先に（手前から）、透ける物を後で（奥から）
    const solid = items.filter((x) => !x.clear).sort((a, b) => a.depth - b.depth);
    const clear = items.filter((x) => x.clear).sort((a, b) => b.depth - a.depth);
    gl.disable(gl.BLEND);
    for (const x of solid) this.one(x.m, x.mesh, x.mat, x.joints);
    if (clear.length) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const x of clear) this.one(x.m, x.mesh, x.mat, x.joints);
      gl.depthMask(true);
    }
    gl.enable(gl.CULL_FACE);
    if (opts.grid) this.grid(opts.grid.center, opts.grid.half);
    gl.bindVertexArray(null);

    // アンチエイリアスをならして、2D の描く先へ重ねる
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaa);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolve);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.framebuffer);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.blit);
    gl.bindTexture(gl.TEXTURE_2D, this.color);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    this.draws++;
  }

  private gridVao: WebGLVertexArrayObject | null = null;
  private gridBuf: WebGLBuffer | null = null;
  /** 地面の格子（奥行きは比べるが、書き込まない。透ける線） */
  private grid(center: Vec3, half: number): void {
    const gl = this.gl;
    const n = Math.max(4, Math.min(100, Math.round(half)));
    const cx = Math.round(center[0]), cz = Math.round(center[2]);
    const minor: number[] = [], major: number[] = [], xs: number[] = [], zs: number[] = [];
    const line = (into: number[], a: Vec3, b: Vec3) => into.push(a[0], a[1], a[2], 0, 1, 0, 0, 0, b[0], b[1], b[2], 0, 1, 0, 0, 0);
    for (let i = -n; i <= n; i++) {
      const x = cx + i, z = cz + i;
      // 床（y = 0 の板）と重なってちらつかないよう、わずかに浮かせる
      line(x === 0 ? zs : x % 10 === 0 ? major : minor, [x, 0.004, cz - n], [x, 0.004, cz + n]);
      line(z === 0 ? xs : z % 10 === 0 ? major : minor, [cx - n, 0.004, z], [cx + n, 0.004, z]);
    }
    if (!this.gridVao) {
      this.gridVao = gl.createVertexArray()!;
      this.gridBuf = gl.createBuffer()!;
      gl.bindVertexArray(this.gridVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
      for (const [i, k, o] of [[0, 3, 0], [1, 3, 3], [2, 2, 6]]) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, k, gl.FLOAT, false, 32, o * 4); }
    }
    gl.bindVertexArray(this.gridVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.uniformMatrix4fv(this.u('u_model'), false, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    gl.uniformMatrix3fv(this.u('u_normalMat'), false, new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]));
    gl.uniform1f(this.u('u_unlit'), 1);
    gl.uniform1f(this.u('u_skin'), 0);
    gl.uniform2f(this.u('u_tile'), 1, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    for (const [verts, r, g, b, a] of [[minor, 1, 1, 1, 0.13], [major, 1, 1, 1, 0.3], [xs, 1, 0.35, 0.35, 0.7], [zs, 0.4, 0.55, 1, 0.7]] as const) {
      if (!verts.length) continue;
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
      gl.uniform4f(this.u('u_color'), r, g, b, a);
      gl.drawArrays(gl.LINES, 0, verts.length / 8);
      this.draws++;
    }
    gl.depthMask(true);
  }

  private jointTex: WebGLTexture | null = null;
  /** 骨の行列を、幅4（行列の列）× 骨の数 の画像にして渡す（1番） */
  private bindJoints(joints: Float32Array): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    if (!this.jointTex) {
      this.jointTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.jointTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.jointTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, joints.length / 16, 0, gl.RGBA, gl.FLOAT, joints);
    gl.activeTexture(gl.TEXTURE0);
  }
  private one(m: Mat4, mesh: Mesh, mat: Mat, joints?: Float32Array): void {
    const gl = this.gl;
    gl.uniform1f(this.u('u_skin'), joints ? 1 : 0);
    if (joints) this.bindJoints(joints);
    gl.uniformMatrix4fv(this.u('u_model'), false, new Float32Array(m));
    gl.uniformMatrix3fv(this.u('u_normalMat'), false, new Float32Array(normalMatrix(m)));
    gl.uniform4f(this.u('u_color'), mat.color[0], mat.color[1], mat.color[2], mat.color[3]);
    gl.uniform1f(this.u('u_unlit'), mat.unlit ? 1 : 0);
    gl.uniform1f(this.u('u_roughness'), mat.roughness);
    gl.uniform2f(this.u('u_tile'), mat.tile[0], mat.tile[1]);
    if (mat.doubleSided) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
    gl.bindTexture(gl.TEXTURE_2D, mat.tex);
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, mesh.type, 0);
    this.draws++;
  }

  /** シーンの光（太陽1つ・点の光）と全体の明るさの設定を集める */
  private findLights(world: LayerFrame['world']): Lights {
    let env: Record<string, any> | undefined;
    let sun: Lights['sun'] = null;
    const pos: number[] = [], col: number[] = [], range: number[] = [];
    let any = false;
    for (const e of world.entities.values()) {
      env ??= e.c.Environment3D as Record<string, any> | undefined;
      const l = e.c.Light3D as Record<string, any> | undefined;
      if (!l) continue;
      any = true;
      if (l.enabled === false) continue;
      const m = matrixOf(world, e);
      if (!m) continue;
      const k = l.intensity ?? 1, [r, g, b] = rgb(l.color ?? '#ffffff');
      if (l.kind === 'point') {
        if (range.length < MAX_POINT) { pos.push(m[12], m[13], m[14]); col.push(r * k, g * k, b * k); range.push(l.range ?? 10); }
      } else if (!sun) sun = { dir: normalize(transformDirection(m, [0, 0, 1])), color: [r * k, g * k, b * k], shadow: l.shadow !== false, range: l.shadowRange ?? 30 };
    }
    // 光を1つも置いていなければ、斜め上からの既定の太陽
    if (!any) sun = { dir: normalize([-0.4, -0.8, -0.45]), color: [0.9, 0.9, 0.85], shadow: true, range: 30 };
    return { sun, pos, col, range, env };
  }

  /** 光と全体の明るさ・霧を、本番のシェーダーへ */
  private lights(L: Lights, background: string): void {
    const gl = this.gl, env = L.env;
    gl.uniform3fv(this.u('u_sunDir'), L.sun?.dir ?? [0, -1, 0]);
    gl.uniform3fv(this.u('u_sunColor'), L.sun?.color ?? [0, 0, 0]);
    gl.uniform1i(this.u('u_pointCount'), L.range.length);
    if (L.range.length) {
      gl.uniform3fv(this.u('u_pointPos'), L.pos);
      gl.uniform3fv(this.u('u_pointColor'), L.col);
      gl.uniform1fv(this.u('u_pointRange'), L.range);
    }
    const amb = env?.ambient ?? 0.6;
    gl.uniform3fv(this.u('u_sky'), rgb(env?.sky ?? '#b8c4d8').map((v) => v * amb));
    gl.uniform3fv(this.u('u_ground'), rgb(env?.ground ?? '#5a5348').map((v) => v * amb));
    gl.uniform4f(this.u('u_fog'), env?.fogNear ?? 20, env?.fogFar ?? 80, env?.fog ? 1 : 0, 0);
    gl.uniform3fv(this.u('u_fogColor'), rgb(background));
  }
}

/** 面の向き（法線）を回す 3x3（行列の左上の逆の転置。倍率が軸ごとに違っても向きが正しい） */
function normalMatrix(m: Mat4): number[] {
  const inv = invert([m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, 0, 0, 0, 1]);
  if (!inv) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return [inv[0], inv[4], inv[8], inv[1], inv[5], inv[9], inv[2], inv[6], inv[10]];
}

function rgb(hex: string): Vec3 {
  const n = parseInt(hex.slice(1, 7), 16);
  return Number.isNaN(n) ? [1, 1, 1] : [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
/** a/./b・a/../b を整える（モデルの外の画像の場所） */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) { if (seg === '..') out.pop(); else if (seg && seg !== '.') out.push(seg); }
  return out.join('/');
}
const alphaOf = (hex: unknown): number => (typeof hex === 'string' && hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1);

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`3D のシェーダーをコンパイルできません: ${gl.getShaderInfoLog(s)}`);
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`3D のシェーダーをつなげられません: ${gl.getProgramInfoLog(p)}`);
  return p;
}

export function createLayer3D(host: LayerHost): Layer3D {
  return new Layer3D(host);
}
