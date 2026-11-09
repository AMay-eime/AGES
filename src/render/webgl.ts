// WebGL2 の2D描画（依存ゼロ）。ロジックからは独立していて、World を読むだけ。
// - 画像（スプライトシートのコマ）・図形・文字を、層と順番どおりに描く
// - 同じ画像・同じ重ね方が続く間はまとめて1回で描く（大量の弾でも速い）
// - 描いたものの形を shapes に残す（クリックでの選択に使う）
import type { World, Entity } from '../core/world.ts';
import type { SheetDef } from '../core/sheet.ts';
import { camerasOf, worldToScreen, type CameraView } from '../core/camera.ts';
import { collectDrawables, cornersOf, pointInCorners, spriteGeometry, type Corners } from './geom.ts';
import { ParticleSim } from './particles.ts';
import { STD_SHADERS, codeHash, wrapShader, type ShaderDef } from '../core/shader.ts';

export interface RendererOptions {
  /** アセットの場所（assets/ship.png）から読み込むURLを作る */
  urlOf(path: string): string;
  /** 画像の場所 → 切り方 */
  sheets: Map<string, SheetDef>;
  /** nearest=ドット絵向け、linear=なめらか */
  filter?: 'nearest' | 'linear';
  /** シェーダー（場所 → 宣言と中身）。省くと標準のものだけ */
  shaders?: Map<string, ShaderDef>;
  /** シェーダーをコンパイルした結果（error が null なら通った）。中身が変わるたびに1回 */
  onShaderResult?(path: string, hash: string, error: string | null): void;
}

/** コンパイルしたシェーダー */
interface Prog {
  prog: WebGLProgram;
  def: ShaderDef;
  loc: Map<string, WebGLUniformLocation | null>;
}

/** 効果つきで描くときの設定（同じものが続く間はまとめて描く） */
interface Mat {
  prog: Prog;
  params: Record<string, unknown>;
  /** コマの範囲 (u0, v0, u1, v1) */
  rect: [number, number, number, number];
}

interface Tex {
  tex: WebGLTexture;
  w: number;
  h: number;
  ready: boolean;
  /** 読み込みが終わった（読めなかったときも） */
  loaded?: Promise<void>;
}

const MAX_QUADS = 4096;
const FLOATS = 8; // x y u v r g b a

const VS = `#version 300 es
in vec2 a_pos; in vec2 a_uv; in vec4 a_color;
uniform vec2 u_res;
out vec2 v_uv; out vec4 v_color;
void main() {
  vec2 clip = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_uv; v_color = a_color;
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 v_uv; in vec4 v_color;
uniform sampler2D u_tex;
out vec4 outColor;
void main() { outColor = texture(u_tex, v_uv) * v_color; }`;

type TransformLike = { x: number; y: number; rot: number; sx: number; sy: number };

export interface DrawnShape {
  id: string;
  /** 描く先（キャンバス）の座標での4つの角 */
  corners: Corners;
  /** どのカメラで描いたか（cams の番号） */
  cam: number;
}

export interface DrawOptions {
  background: string;
  /** ゲームの設計の大きさ（既定のカメラの中心に使う）。省くとキャンバスの大きさ */
  design?: { width: number; height: number };
  /** カメラを使わず、この視点で全部の層を描く（エディタの自由な視点） */
  view?: CameraView;
  /** 画面全体を覆う色（シーンの切り替えのフェード。Game.overlay() の値） */
  overlay?: { color: string; alpha: number } | null;
  /** 画面全体の後処理（PostEffect）をかけるか（既定 true。エディタの自由な視点ではかけない） */
  post?: boolean;
  /**
   * パーティクルを動かす。dt は進める秒数（一時停止中は 0）。
   * preview は編集中（ゲームを動かしていない）に試しに粒を出す物（エディタで選んだ物）。渡さなければ再生中として rate の分も出す。
   * particles を渡さなければ粒は動かさない（出す命令の粒は止まったまま描く）
   */
  particles?: { dt: number; preview?: string[] };
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  opts: RendererOptions;
  /** 直前に描いたものの形（奥から手前の順） */
  shapes: DrawnShape[] = [];
  /** 直前に使ったカメラ（描いた順） */
  cams: CameraView[] = [];
  private cam!: CameraView;
  private camIndex = 0;
  private prog: WebGLProgram;
  private vbo: WebGLBuffer;
  private verts = new Float32Array(MAX_QUADS * 4 * FLOATS);
  private count = 0;
  private curTex: WebGLTexture | null = null;
  private curBlend = '';
  private curMat: Mat | null = null;
  private curSize: [number, number] = [1, 1];
  /** 描く先の大きさ（u_res） */
  private resW = 1;
  private resH = 1;
  private readonly t0 = performance.now();
  private progs = new Map<string, { hash: string; prog: Prog | null; error: string | null }>();
  private fbo: { w: number; h: number; tex: WebGLTexture[]; fb: WebGLFramebuffer[] } | null = null;
  private textures = new Map<string, Tex>();
  private white: Tex;
  private circle: Tex;
  private missing: Tex;
  private textCache = new Map<string, Tex & { used: number }>();
  private frameNo = 0;
  private colors = new Map<string, [number, number, number]>();
  private measure: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement, opts: RendererOptions) {
    this.canvas = canvas;
    this.opts = opts;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: false, antialias: false });
    if (!gl) throw new Error('このブラウザは WebGL2 に対応していません。最近の Chrome / Edge / Firefox を使ってください');
    this.gl = gl;
    this.prog = this.program(VS, FS);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.byteLength, gl.DYNAMIC_DRAW);
    const ibo = gl.createBuffer()!;
    const idx = new Uint16Array(MAX_QUADS * 6);
    for (let i = 0; i < MAX_QUADS; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    // 頂点の並びはどのシェーダーでも同じ場所に結びつける（効果のシェーダーも同じ頂点で描く）
    const attr = (loc: number, size: number, offset: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, FLOATS * 4, offset * 4);
    };
    attr(0, 2, 0);
    attr(1, 2, 2);
    attr(2, 4, 4);
    gl.enable(gl.BLEND);
    this.white = this.fromCanvas(this.makeCanvas(1, 1, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 1, 1); }), 'nearest');
    this.circle = this.fromCanvas(this.makeCanvas(128, 128, (g) => { g.fillStyle = '#fff'; g.beginPath(); g.arc(64, 64, 63, 0, Math.PI * 2); g.fill(); }), 'linear');
    this.missing = this.fromCanvas(this.makeCanvas(2, 2, (g) => { g.fillStyle = '#ff00ff'; g.fillRect(0, 0, 1, 1); g.fillRect(1, 1, 1, 1); g.fillStyle = '#000'; g.fillRect(1, 0, 1, 1); g.fillRect(0, 1, 1, 1); }), 'nearest');
    this.measure = this.makeCanvas(1, 1, () => {}).getContext('2d')!;
  }

  /** 画像が読み込み済みなら、その大きさ */
  imageSize(path: string): { w: number; h: number } | null {
    const t = this.texture(path);
    return t.ready ? { w: t.w, h: t.h } : null;
  }

  /** 画像を読み直す（ファイルが変わったとき） */
  invalidate(path?: string): void {
    for (const [k, t] of this.textures) if (!path || k === path) { this.gl.deleteTexture(t.tex); this.textures.delete(k); }
  }

  /**
   * 描く。カメラ（Camera）があればカメラごとに、その範囲・層だけを描く。なければ画面全体をそのまま映す。
   * 第2引数に色だけを渡す古い書き方も使える
   */
  draw(world: World, opts: DrawOptions | string): void {
    const o: DrawOptions = typeof opts === 'string' ? { background: opts } : opts;
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    this.frameNo++;
    gl.viewport(0, 0, W, H);
    this.resW = W; this.resH = H;
    this.shapes = [];
    this.cams = o.view ? [o.view] : camerasOf(world, W, H, o.design?.width ?? W, o.design?.height ?? H);
    // 後処理があれば、いったん画面の外（テクスチャ）に描く。camera を決めた後処理は、そのカメラを描いた直後に、その範囲にかける
    const passes = o.view || o.post === false ? new Map<number, Mat[]>() : this.postPasses(world, W, H);
    let cur = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, passes.size ? this.target(W, H, cur) : null);
    const [r, g, b] = this.rgb(o.background);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform2f(gl.getUniformLocation(this.prog, 'u_res'), W, H);
    if (o.particles) this.particles.update(world, o.particles.dt, o.particles.preview);
    const all = collectDrawables(world, this.particles.orphans());
    gl.enable(gl.SCISSOR_TEST);
    this.cams.forEach((cam, i) => {
      this.cam = cam;
      this.camIndex = i;
      // 描く範囲を切り取る（WebGL の y は下から）
      gl.scissor(Math.floor(cam.vx), Math.floor(H - cam.vy - cam.vh), Math.ceil(cam.vw), Math.ceil(cam.vh));
      if (cam.clear) {
        const [cr, cg, cb] = this.rgb(cam.clear);
        gl.clearColor(cr, cg, cb, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      for (const d of all) {
        if (d.layer < cam.layerMin || d.layer > cam.layerMax) continue;
        if (d.kind === 'sprite') this.sprite(d.e);
        else if (d.kind === 'shape') this.shape(d.e);
        else if (d.kind === 'particles') this.drawParticles(d.e);
        else this.text(d.e);
      }
      this.flush();
      const here = passes.get(i);
      if (here) {
        // このカメラの後処理: かけた結果に、残りのカメラ（UI など）を重ねる
        gl.disable(gl.SCISSOR_TEST);
        cur = this.applyPost(here, cur, W, H, false);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.target(W, H, cur));
        gl.enable(gl.SCISSOR_TEST);
      }
    });
    gl.disable(gl.SCISSOR_TEST);
    if (passes.size) {
      const last = passes.get(-1);
      if (last) this.applyPost(last, cur, W, H, true);
      else this.applyPost([null], cur, W, H, true); // 画面へ写すだけ
    }
    if (o.overlay && o.overlay.alpha > 0) {
      this.quad(this.white, 'normal', [0, 0, W, 0, W, H, 0, H], 0, 0, 1, 1, o.overlay.color, Math.min(1, o.overlay.alpha));
      this.flush();
    }
    this.gcText();
  }

  /** 画像を先に読み込む（シーンに入る前に。読み込み終わるか、読めなかったら終わる） */
  preload(paths: string[]): Promise<void> {
    return Promise.all(paths.map((p) => this.texture(p).loaded)).then(() => {});
  }

  /** 座標（描く先のpx）にあるもののID（手前から奥の順）。カメラの範囲の外で切れている部分は選ばない */
  pickAll(x: number, y: number): string[] {
    const out: string[] = [];
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      const c = this.cams[s.cam];
      if (c && (x < c.vx || y < c.vy || x > c.vx + c.vw || y > c.vy + c.vh)) continue;
      if (pointInCorners(x, y, s.corners) && !out.includes(s.id)) out.push(s.id);
    }
    return out;
  }

  /** ワールドの4つの角を、いまのカメラで描く先の座標にする。範囲の外なら null（描かない） */
  private place(id: string, q: Corners, pick = true): Corners | null {
    const c = this.cam;
    const out = [0, 0, 0, 0, 0, 0, 0, 0] as Corners;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 4; i++) {
      const [sx, sy] = worldToScreen(c, q[i * 2], q[i * 2 + 1]);
      out[i * 2] = sx; out[i * 2 + 1] = sy;
      x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
    }
    if (x1 < c.vx || y1 < c.vy || x0 > c.vx + c.vw || y0 > c.vy + c.vh) return null;
    if (pick) this.shapes.push({ id, corners: out, cam: this.camIndex });
    return out;
  }

  // ---------- 描くもの ----------

  private sprite(e: Entity): void {
    const s = e.c.Sprite, t = e.c.Transform as TransformLike;
    let tex: Tex = this.missing;
    let u0 = 0, v0 = 0, u1 = 1, v1 = 1;
    let w = 16, h = 16, ax = s.anchor?.[0] ?? 0.5, ay = s.anchor?.[1] ?? 0.5;
    if (s.image) {
      const tx = this.texture(s.image);
      if (!tx.ready) return; // 読み込み中は描かない
      const g = spriteGeometry(s, this.opts.sheets.get(s.image), tx.w, tx.h);
      if (g) {
        tex = tx;
        // なめらか表示のときは隣のコマがにじまないよう半ピクセル内側を使う
        const inset = this.opts.filter === 'nearest' ? 0 : 0.5;
        u0 = (g.src.x + inset) / tx.w; v0 = (g.src.y + inset) / tx.h;
        u1 = (g.src.x + g.src.w - inset) / tx.w; v1 = (g.src.y + g.src.h - inset) / tx.h;
        ({ w, h, ax, ay } = g);
      } // コマが見つからないときは市松模様で知らせる（検証でも知らせる）
    }
    if (tex === this.missing) {
      if (s.size?.[0] > 0) w = s.size[0];
      if (s.size?.[1] > 0) h = s.size[1];
    }
    if (s.flipX) [u0, u1] = [u1, u0];
    if (s.flipY) [v0, v1] = [v1, v0];
    const q = this.place(e.id, cornersOf(t, w, h, ax, ay));
    if (q) this.quad(tex, s.blend ?? 'normal', q, u0, v0, u1, v1, s.tint ?? '#ffffff', s.alpha ?? 1, this.material(e, [u0, v0, u1, v1]));
  }

  /** パーティクル（描く側で動かす）。粒は選べない */
  readonly particles = new ParticleSim();

  private drawParticles(e: Entity): void {
    const em = this.particles.emitters.get(e.id);
    if (!em?.parts.length) return;
    const p = em.ghost.c.Particles, tr = em.ghost.c.Transform;
    let tex: Tex = p.shape === 'square' ? this.white : this.circle;
    let u0 = 0, v0 = 0, u1 = 1, v1 = 1, aspect = 1;
    if (p.shape === 'image' && p.image) {
      const tx = this.texture(p.image);
      if (!tx.ready) return;
      const g = spriteGeometry({ frame: p.frame }, this.opts.sheets.get(p.image), tx.w, tx.h);
      if (!g) return;
      tex = tx;
      u0 = g.src.x / tx.w; v0 = g.src.y / tx.h; u1 = (g.src.x + g.src.w) / tx.w; v1 = (g.src.y + g.src.h) / tx.h;
      aspect = g.h / g.w;
    }
    const mat = this.material(em.ghost, [u0, v0, u1, v1]);
    for (const q of em.parts) {
      const look = ParticleSim.look(p, q);
      if (look.size <= 0 || look.alpha <= 0) continue;
      const x = p.world ? q.x : tr.x + q.x, y = p.world ? q.y : tr.y + q.y;
      const corners = this.place(e.id, cornersOf({ x, y, rot: q.rot }, look.size, look.size * aspect, 0.5, 0.5), false);
      if (corners) this.quad(tex, p.blend ?? 'add', corners, u0, v0, u1, v1, look.color, look.alpha, mat);
    }
  }

  private shape(e: Entity): void {
    const s = e.c.Shape, t = e.c.Transform as TransformLike;
    const q = this.place(e.id, cornersOf(t, s.w, s.h, 0.5, 0.5));
    if (q) this.quad(s.kind === 'circle' ? this.circle : this.white, 'normal', q, 0, 0, 1, 1, s.color, s.alpha ?? 1, this.material(e));
  }

  private text(e: Entity): void {
    const tx = e.c.Text, t = e.c.Transform as TransformLike;
    if (!tx.text) return;
    const font = `${Math.round(tx.size)}px ${tx.font ? this.fontFamily(tx.font) : 'system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif'}`;
    const key = `${font}|${tx.text}`;
    let tex = this.textCache.get(key);
    if (!tex) {
      this.measure.font = font;
      const lines = String(tx.text).split('\n');
      const w = Math.max(1, Math.ceil(Math.max(...lines.map((l) => this.measure.measureText(l).width))) + 4);
      const lh = Math.ceil(tx.size * 1.25);
      const c = this.makeCanvas(w, lh * lines.length, (g) => {
        g.font = font;
        g.fillStyle = '#fff';
        g.textBaseline = 'middle';
        lines.forEach((l, i) => g.fillText(l, 2, lh * (i + 0.5)));
      });
      tex = { ...this.fromCanvas(c, 'linear'), used: 0 };
      this.textCache.set(key, tex);
    }
    tex.used = this.frameNo;
    const ax = tx.align === 'center' ? 0.5 : tx.align === 'right' ? 1 : 0;
    const q = this.place(e.id, cornersOf(t, tex.w, tex.h, ax, 0.5));
    if (q) this.quad(tex, 'normal', q, 0, 0, 1, 1, tx.color, 1, this.material(e));
  }

  // ---------- まとめて描く ----------

  private quad(tex: Tex, blend: string, q: Corners, u0: number, v0: number, u1: number, v1: number, color: string, alpha: number, mat: Mat | null = null): void {
    if (tex.tex !== this.curTex || blend !== this.curBlend || mat !== this.curMat || this.count >= MAX_QUADS) {
      this.flush();
      this.curTex = tex.tex;
      this.curBlend = blend;
      this.curMat = mat;
      this.curSize = [tex.w, tex.h];
    }
    const [r, g, b] = this.rgb(color);
    const o = this.count * 4 * FLOATS;
    const uv = [u0, v0, u1, v0, u1, v1, u0, v1];
    for (let i = 0; i < 4; i++) {
      this.verts.set([q[i * 2], q[i * 2 + 1], uv[i * 2], uv[i * 2 + 1], r, g, b, alpha], o + i * FLOATS);
    }
    this.count++;
  }

  private flush(): void {
    if (!this.count || !this.curTex) { this.count = 0; return; }
    const gl = this.gl;
    switch (this.curBlend) {
      case 'none': gl.blendFunc(gl.ONE, gl.ZERO); break;
      case 'add': gl.blendFunc(gl.SRC_ALPHA, gl.ONE); break;
      case 'multiply': gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA); break;
      case 'screen': gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR); break;
      default: gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    if (this.curMat) this.useMaterial(this.curMat);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.curTex);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts.subarray(0, this.count * 4 * FLOATS));
    gl.drawElements(gl.TRIANGLES, this.count * 6, gl.UNSIGNED_SHORT, 0);
    if (this.curMat) gl.useProgram(this.prog);
    this.count = 0;
  }

  // ---------- シェーダー（効果と後処理） ----------

  /** 物の Effect から、効果つきで描く設定を作る（効果がなければ null） */
  private material(e: Entity, rect: [number, number, number, number] = [0, 0, 1, 1]): Mat | null {
    const ef = e.c.Effect;
    if (!ef?.shader) return null;
    const prog = this.shaderProg(ef.shader);
    return prog ? { prog, params: ef.params ?? {}, rect } : null;
  }

  private useMaterial(m: Mat): void {
    const gl = this.gl, p = m.prog;
    gl.useProgram(p.prog);
    const u = (name: string) => {
      if (!p.loc.has(name)) p.loc.set(name, gl.getUniformLocation(p.prog, name));
      return p.loc.get(name)!;
    };
    gl.uniform2f(u('u_res'), this.resW, this.resH);
    gl.uniform1i(u('u_tex'), 0);
    gl.uniform2f(u('u_texel'), 1 / this.curSize[0], 1 / this.curSize[1]);
    gl.uniform4f(u('u_rect'), ...m.rect);
    gl.uniform1f(u('u_time'), (performance.now() - this.t0) / 1000);
    let unit = 1;
    for (const [name, type] of Object.entries(p.def.glsl)) {
      const v = m.params[name] ?? p.def.uniforms[name].default;
      const loc = u(name);
      switch (type) {
        case 'float': gl.uniform1f(loc, Number(v)); break;
        case 'int': case 'bool': gl.uniform1i(loc, Number(v)); break;
        case 'vec2': { const [x, y] = v as number[]; gl.uniform2f(loc, x, y); break; }
        case 'vec3': gl.uniform3f(loc, ...this.rgb(String(v))); break;
        case 'vec4': gl.uniform4f(loc, ...this.rgb(String(v)), 1); break;
        case 'sampler2D': {
          const tx = v ? this.texture(String(v)) : this.white;
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, (tx.ready ? tx : this.white).tex);
          gl.uniform1i(loc, unit++);
          break;
        }
      }
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  /** シェーダーをコンパイルする（中身が変わったときだけ）。使えなければ null */
  private shaderProg(path: string): Prog | null {
    const def = (this.opts.shaders ?? STD_SHADERS).get(path);
    if (!def || def.errors.length) return null;
    const hash = codeHash(def.code);
    const got = this.progs.get(path);
    if (got?.hash === hash) return got.prog;
    if (got?.prog) this.gl.deleteProgram(got.prog.prog);
    let prog: Prog | null = null, error: string | null = null;
    try {
      prog = { prog: this.program(VS, wrapShader(def)), def, loc: new Map() };
    } catch (e) {
      error = shaderError(path, (e as Error).message);
      console.warn(error);
    }
    this.progs.set(path, { hash, prog, error });
    this.opts.onShaderResult?.(path, hash, error);
    return prog;
  }

  /** シェーダーを全部コンパイルして、結果を知らせる（使っていないものも。AI が書いたらすぐ確かめられるように） */
  compileAll(): void {
    for (const path of (this.opts.shaders ?? STD_SHADERS).keys()) this.shaderProg(path);
  }

  /** コンパイルの結果（場所 → エラー。通ったものは null） */
  shaderErrors(): Map<string, string | null> {
    return new Map([...this.progs].map(([k, v]) => [k, v.error]));
  }

  /** 画面全体の後処理（順番どおり。かけられるものだけ） */
  /** 後処理を、かける所ごとに（カメラの番号 → 順番どおりの並び。-1 は全部のカメラの後） */
  private postPasses(world: World, W: number, H: number): Map<number, Mat[]> {
    const list = [...world.entities.values()]
      .filter((e) => e.c.PostEffect && e.c.PostEffect.enabled !== false && e.c.PostEffect.shader)
      .sort((a, b) => (a.c.PostEffect.order ?? 0) - (b.c.PostEffect.order ?? 0));
    const out = new Map<number, Mat[]>();
    if (!list.length) return out;
    // frameUV はかける範囲（そのカメラ、または全部のカメラを合わせた四角）の中で 0〜1。外はそのまま。画面の外のテクスチャは上下が逆
    const rectOf = (cams: CameraView[]): Mat['rect'] => {
      if (!cams.length) return [0, 1, 1, 0];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of cams) { x0 = Math.min(x0, c.vx); y0 = Math.min(y0, c.vy); x1 = Math.max(x1, c.vx + c.vw); y1 = Math.max(y1, c.vy + c.vh); }
      return [x0 / W, 1 - y0 / H, x1 / W, 1 - y1 / H];
    };
    for (const e of list) {
      const prog = this.shaderProg(e.c.PostEffect.shader);
      if (!prog) continue;
      const ci = e.c.PostEffect.camera ? this.cams.findIndex((c) => c.id === e.c.PostEffect.camera) : -1;
      const at = ci >= 0 ? ci : -1;
      if (!out.has(at)) out.set(at, []);
      out.get(at)!.push({ prog, params: e.c.PostEffect.params ?? {}, rect: rectOf(at >= 0 ? [this.cams[at]] : this.cams) });
    }
    return out;
  }

  /** 画面の外に描く先（後処理の行き来に2つ使う） */
  private target(w: number, h: number, i: number): WebGLFramebuffer {
    const gl = this.gl;
    if (!this.fbo || this.fbo.w !== w || this.fbo.h !== h) {
      if (this.fbo) { this.fbo.tex.forEach((t) => gl.deleteTexture(t)); this.fbo.fb.forEach((f) => gl.deleteFramebuffer(f)); }
      const tex: WebGLTexture[] = [], fb: WebGLFramebuffer[] = [];
      for (let k = 0; k < 2; k++) {
        const t = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const f = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        tex.push(t); fb.push(f);
      }
      this.fbo = { w, h, tex, fb };
      this.curTex = null;
    }
    return this.fbo.fb[i];
  }

  /** 後処理を順にかける（null は写すだけ）。toScreen なら最後は画面へ。結果の入った描く先の番号を返す */
  private applyPost(passes: (Mat | null)[], src: number, W: number, H: number, toScreen: boolean): number {
    const gl = this.gl;
    passes.forEach((m, i) => {
      const last = i === passes.length - 1;
      gl.bindFramebuffer(gl.FRAMEBUFFER, last && toScreen ? null : this.target(W, H, 1 - src));
      const tex: Tex = { tex: this.fbo!.tex[src], w: W, h: H, ready: true };
      // 画面の外のテクスチャは上下が逆なので、左上の頂点に v=1 を当てる
      this.quad(tex, 'none', [0, 0, W, 0, W, H, 0, H], 0, 1, 1, 0, '#ffffff', 1, m);
      this.flush();
      src = 1 - src;
    });
    this.curTex = null;
    return src;
  }


  // ---------- テクスチャ ----------

  private texture(path: string): Tex {
    let t = this.textures.get(path);
    if (t) return t;
    const gl = this.gl;
    t = { tex: gl.createTexture()!, w: 1, h: 1, ready: false };
    this.textures.set(path, t);
    const img = new Image();
    const target = t;
    target.loaded = new Promise<void>((done) => {
      img.onload = () => {
        this.upload(target, img, this.opts.filter ?? 'linear');
        target.w = img.naturalWidth;
        target.h = img.naturalHeight;
        target.ready = true;
        done();
      };
      img.onerror = () => { console.warn(`画像を読み込めません: ${path}`); done(); };
    });
    img.src = this.opts.urlOf(path);
    return t;
  }

  private upload(t: Tex, src: TexImageSource, filter: 'nearest' | 'linear'): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const f = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.curTex = null;
  }

  private fromCanvas(c: HTMLCanvasElement, filter: 'nearest' | 'linear'): Tex {
    const t: Tex = { tex: this.gl.createTexture()!, w: c.width, h: c.height, ready: true };
    this.upload(t, c, filter);
    return t;
  }

  private makeCanvas(w: number, h: number, paint: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    paint(c.getContext('2d')!);
    return c;
  }

  /** しばらく使われていない文字の画像を捨てる */
  private gcText(): void {
    if (this.textCache.size < 512) return;
    for (const [k, t] of this.textCache) if (this.frameNo - t.used > 120) { this.gl.deleteTexture(t.tex); this.textCache.delete(k); }
  }

  private fonts = new Map<string, string>();
  private fontFamily(path: string): string {
    let fam = this.fonts.get(path);
    if (fam) return fam;
    fam = `ages-font-${this.fonts.size}`;
    this.fonts.set(path, fam);
    const face = new FontFace(fam, `url(${this.opts.urlOf(path)})`);
    face.load().then((f) => {
      document.fonts.add(f);
      for (const [k, t] of this.textCache) if (k.includes(fam!)) { this.gl.deleteTexture(t.tex); this.textCache.delete(k); }
    }).catch(() => console.warn(`フォントを読み込めません: ${path}`));
    return fam;
  }

  private rgb(hex: string): [number, number, number] {
    let c = this.colors.get(hex);
    if (!c) {
      const m = /^#?([0-9a-f]{6})/i.exec(hex);
      const n = m ? parseInt(m[1], 16) : 0xffffff;
      c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
      this.colors.set(hex, c);
    }
    return c;
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`シェーダーのエラー: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.bindAttribLocation(p, 1, 'a_uv');
    gl.bindAttribLocation(p, 2, 'a_color');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`シェーダーのエラー: ${gl.getProgramInfoLog(p)}`);
    return p;
  }
}

/** コンパイルのエラーを「ファイル:行: 内容」に（#line 1 でファイルの行と合わせてある） */
function shaderError(path: string, message: string): string {
  const lines = [...message.matchAll(/ERROR:\s*\d+:(\d+):\s*([^\n]*)/g)].map((m) => `${path}:${m[1]}: ${m[2].trim()}`);
  return lines.length ? lines.join('\n') : `${path}: ${message.replace(/^シェーダーのエラー:\s*/, '')}`;
}
