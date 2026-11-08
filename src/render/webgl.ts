// WebGL2 の2D描画（依存ゼロ）。ロジックからは独立していて、World を読むだけ。
// - 画像（スプライトシートのコマ）・図形・文字を、層と順番どおりに描く
// - 同じ画像・同じ重ね方が続く間はまとめて1回で描く（大量の弾でも速い）
// - 描いたものの形を shapes に残す（クリックでの選択に使う）
import type { World, Entity } from '../core/world.ts';
import type { SheetDef } from '../core/sheet.ts';
import { collectDrawables, cornersOf, pointInCorners, spriteGeometry, type Corners } from './geom.ts';

export interface RendererOptions {
  /** アセットの場所（assets/ship.png）から読み込むURLを作る */
  urlOf(path: string): string;
  /** スプライトシート（定義ファイルの場所 → 中身） */
  /** 画像の場所 → 切り方 */
  sheets: Map<string, SheetDef>;
  /** nearest=ドット絵向け、linear=なめらか */
  filter?: 'nearest' | 'linear';
}

interface Tex {
  tex: WebGLTexture;
  w: number;
  h: number;
  ready: boolean;
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
  corners: Corners;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  opts: RendererOptions;
  /** 直前に描いたものの形（奥から手前の順） */
  shapes: DrawnShape[] = [];
  private prog: WebGLProgram;
  private vbo: WebGLBuffer;
  private verts = new Float32Array(MAX_QUADS * 4 * FLOATS);
  private count = 0;
  private curTex: WebGLTexture | null = null;
  private curBlend = '';
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
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(this.prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, FLOATS * 4, offset * 4);
    };
    attr('a_pos', 2, 0);
    attr('a_uv', 2, 2);
    attr('a_color', 4, 4);
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

  draw(world: World, background: string): void {
    const gl = this.gl;
    this.frameNo++;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const [r, g, b] = this.rgb(background);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform2f(gl.getUniformLocation(this.prog, 'u_res'), this.canvas.width, this.canvas.height);
    this.shapes = [];
    for (const d of collectDrawables(world)) {
      if (d.kind === 'sprite') this.sprite(d.e);
      else if (d.kind === 'shape') this.shape(d.e);
      else this.text(d.e);
    }
    this.flush();
    this.gcText();
  }

  /** 座標にあるもののID（手前から奥の順） */
  pickAll(x: number, y: number): string[] {
    const out: string[] = [];
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      if (pointInCorners(x, y, s.corners) && !out.includes(s.id)) out.push(s.id);
    }
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
    const q = cornersOf(t, w, h, ax, ay);
    this.shapes.push({ id: e.id, corners: q });
    this.quad(tex, s.blend ?? 'normal', q, u0, v0, u1, v1, s.tint ?? '#ffffff', s.alpha ?? 1);
  }

  private shape(e: Entity): void {
    const s = e.c.Shape, t = e.c.Transform as TransformLike;
    const q = cornersOf(t, s.w, s.h, 0.5, 0.5);
    this.shapes.push({ id: e.id, corners: q });
    this.quad(s.kind === 'circle' ? this.circle : this.white, 'normal', q, 0, 0, 1, 1, s.color, s.alpha ?? 1);
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
    const q = cornersOf(t, tex.w, tex.h, ax, 0.5);
    this.shapes.push({ id: e.id, corners: q });
    this.quad(tex, 'normal', q, 0, 0, 1, 1, tx.color, 1);
  }

  // ---------- まとめて描く ----------

  private quad(tex: Tex, blend: string, q: Corners, u0: number, v0: number, u1: number, v1: number, color: string, alpha: number): void {
    if (tex.tex !== this.curTex || blend !== this.curBlend || this.count >= MAX_QUADS) {
      this.flush();
      this.curTex = tex.tex;
      this.curBlend = blend;
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
      case 'add': gl.blendFunc(gl.SRC_ALPHA, gl.ONE); break;
      case 'multiply': gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA); break;
      case 'screen': gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR); break;
      default: gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.curTex);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts.subarray(0, this.count * 4 * FLOATS));
    gl.drawElements(gl.TRIANGLES, this.count * 6, gl.UNSIGNED_SHORT, 0);
    this.count = 0;
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
    img.onload = () => {
      this.upload(target, img, this.opts.filter ?? 'linear');
      target.w = img.naturalWidth;
      target.h = img.naturalHeight;
      target.ready = true;
    };
    img.onerror = () => console.warn(`画像を読み込めません: ${path}`);
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
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`シェーダーのエラー: ${gl.getProgramInfoLog(p)}`);
    return p;
  }
}
