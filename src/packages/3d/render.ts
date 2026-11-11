// 3D の描画（WebGL2）。2D の描画の下の層（src/render/layer.ts）として、背景の上・2D の物の下に描く。
// - 自分の描く先（色 + 奥行き。4倍のアンチエイリアス）に描いてから、2D の描く先へ重ねる（2D 側に奥行きの用意がなくてよい）
// - 光: 太陽1つ + 点の光8つまで + 全体の明るさ（上と下の色）。影はまだない
// - 色は画面の色のまま計算する（2D の色と同じに見えるように。光の計算を直線の色で行うのは、必要になってから）
import type { LayerFrame, LayerHost, RenderLayer } from '../../render/layer.ts';
import type { Entity } from '../../core/world.ts';
import { box, capsule, cylinder, plane, sphere, type Geometry } from './geometry.ts';
import { invert, multiply, normalize, transformDirection, type Mat4, type Vec3 } from './math.ts';
import { cameraOf, matrixOf, type CameraView3 } from './space.ts';

const MAX_POINT = 8;

const VS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_normal;
layout(location=2) in vec2 a_uv;
uniform mat4 u_viewProj;
uniform mat4 u_model;
uniform mat3 u_normalMat;
uniform vec2 u_tile;
out vec3 v_world;
out vec3 v_normal;
out vec2 v_uv;
void main() {
  vec4 w = u_model * vec4(a_pos, 1.0);
  v_world = w.xyz;
  v_normal = u_normalMat * a_normal;
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
out vec4 o_color;
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

interface Mesh { vao: WebGLVertexArrayObject; count: number }
interface Tex { tex: WebGLTexture; loaded: Promise<void> }

/** 3D の層への指示（DrawOptions.layers['3d']） */
export interface Layer3DOptions {
  /** ゲームのカメラの代わりに、この視点で描く（エディタの自由な視点） */
  camera?: CameraView3;
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
  private loc = new Map<string, WebGLUniformLocation | null>();
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

  private mesh(key: string, make: () => Geometry): Mesh {
    let m = this.meshes.get(key);
    if (m) return m;
    const gl = this.gl, g = make();
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, g.vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
    for (const [i, n, o] of [[0, 3, 0], [1, 3, 3], [2, 2, 6]]) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, 32, o * 4); }
    gl.bindVertexArray(null);
    // カプセルは大きさごとに作るので、増えすぎたら捨てる
    if (this.meshes.size > 200) { for (const x of this.meshes.values()) gl.deleteVertexArray(x.vao); this.meshes.clear(); }
    m = { vao, count: g.indices.length };
    this.meshes.set(key, m);
    return m;
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

  private texture(path: string): WebGLTexture {
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
      img.src = this.host.urlOf(path);
      t = { tex, loaded };
      this.textures.set(path, t);
    }
    return t.tex;
  }

  invalidate(path?: string): void {
    for (const [k, t] of this.textures) if (!path || k === path) { this.gl.deleteTexture(t.tex); this.textures.delete(k); }
  }

  async settled(): Promise<void> {
    await Promise.all([...this.textures.values()].map((t) => t.loaded));
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
    const items: { e: Entity; m: Mat4; mesh: Mesh; c: Record<string, any>; depth: number }[] = [];
    for (const e of world.entities.values()) {
      const c = e.c.Mesh3D as Record<string, any> | undefined;
      if (!c || c.visible === false) continue;
      const wm = matrixOf(world, e);
      if (!wm) continue;
      const size = (c.size ?? [1, 1, 1]) as Vec3;
      const { mesh, scale } = this.shape(c.shape, size);
      const m = multiply(wm, [scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, 0, 0, 0, 1]);
      const depth = (wm[12] - cam.pos[0]) * cam.dir[0] + (wm[13] - cam.pos[1]) * cam.dir[1] + (wm[14] - cam.pos[2]) * cam.dir[2];
      items.push({ e, m, mesh, c, depth });
      this.drawn.push({ id: e.id, matrix: wm, shape: c.shape ?? 'box', size });
    }
    if (!items.length) return;

    const gl = this.gl, W = f.width, H = f.height;
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
    this.lights(f);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.u('u_tex'), 0);

    // 透けない物を先に（手前から）、透ける物を後で（奥から）
    const solid = items.filter((x) => (x.c.alpha ?? 1) >= 1 && alphaOf(x.c.color) >= 1).sort((a, b) => a.depth - b.depth);
    const clear = items.filter((x) => !solid.includes(x)).sort((a, b) => b.depth - a.depth);
    gl.disable(gl.BLEND);
    for (const x of solid) this.one(x.m, x.mesh, x.c);
    if (clear.length) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const x of clear) this.one(x.m, x.mesh, x.c);
      gl.depthMask(true);
    }
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

  private one(m: Mat4, mesh: Mesh, c: Record<string, any>): void {
    const gl = this.gl;
    gl.uniformMatrix4fv(this.u('u_model'), false, new Float32Array(m));
    gl.uniformMatrix3fv(this.u('u_normalMat'), false, new Float32Array(normalMatrix(m)));
    const [r, g, b] = rgb(c.color ?? '#ffffff');
    gl.uniform4f(this.u('u_color'), r, g, b, alphaOf(c.color) * (c.alpha ?? 1));
    gl.uniform1f(this.u('u_unlit'), c.unlit ? 1 : 0);
    gl.uniform1f(this.u('u_roughness'), c.roughness ?? 0.8);
    const tile = c.tile ?? [1, 1];
    gl.uniform2f(this.u('u_tile'), tile[0], tile[1]);
    gl.bindTexture(gl.TEXTURE_2D, this.texture(c.texture ?? ''));
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
    this.draws++;
  }

  /** 光と全体の明るさ・霧 */
  private lights(f: LayerFrame): void {
    const gl = this.gl, world = f.world;
    let env: Record<string, any> | undefined;
    let sun: { dir: Vec3; color: Vec3 } | null = null;
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
      } else if (!sun) sun = { dir: normalize(transformDirection(m, [0, 0, 1])), color: [r * k, g * k, b * k] };
    }
    // 光を1つも置いていなければ、斜め上からの既定の太陽
    if (!any) sun = { dir: normalize([-0.4, -0.8, -0.45]), color: [0.9, 0.9, 0.85] };
    gl.uniform3fv(this.u('u_sunDir'), sun?.dir ?? [0, -1, 0]);
    gl.uniform3fv(this.u('u_sunColor'), sun?.color ?? [0, 0, 0]);
    gl.uniform1i(this.u('u_pointCount'), range.length);
    if (range.length) {
      gl.uniform3fv(this.u('u_pointPos'), pos);
      gl.uniform3fv(this.u('u_pointColor'), col);
      gl.uniform1fv(this.u('u_pointRange'), range);
    }
    const amb = env?.ambient ?? 0.6;
    gl.uniform3fv(this.u('u_sky'), rgb(env?.sky ?? '#b8c4d8').map((v) => v * amb));
    gl.uniform3fv(this.u('u_ground'), rgb(env?.ground ?? '#5a5348').map((v) => v * amb));
    gl.uniform4f(this.u('u_fog'), env?.fogNear ?? 20, env?.fogFar ?? 80, env?.fog ? 1 : 0, 0);
    gl.uniform3fv(this.u('u_fogColor'), rgb(f.background));
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
