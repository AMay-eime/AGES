// WebGL2 の2D描画（依存ゼロ）。ロジックからは独立していて、World を読むだけ。
// - 画像（スプライトシートのコマ）・図形・文字を、層と順番どおりに描く
// - 同じ画像・同じ重ね方が続く間はまとめて1回で描く（大量の弾でも速い）
// - 描いたものの形を shapes に残す（クリックでの選択に使う）
import type { World, Entity } from '../core/world.ts';
import type { SheetDef } from '../core/sheet.ts';
import { camerasOf, defaultCamera, worldToScreen, type CameraView } from '../core/camera.ts';
import { layoutUI, type UiRect } from '../core/ui.ts';
import { collectDrawables, cornersOf, dashSpans, dashedBands, ellipsePerimeter, lineCorners, pointInCorners, ringPiece, spriteGeometry, strokeBands, tileSpans, type Corners } from './geom.ts';
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
  /** UI を描いている間（切り抜きの後に、切り取りを外して戻す） */
  private uiPass = false;
  private prog: WebGLProgram;
  private vbo: WebGLBuffer;
  private verts = new Float32Array(MAX_QUADS * 4 * FLOATS);
  private count = 0;
  private curTex: WebGLTexture | null = null;
  private curBlend = '';
  private curMat: Mat | null = null;
  /** UI の物の四角（描くたびに求める。ロジックと同じ計算） */
  private uiRects = new Map<string, UiRect>();
  /** UI を描いた視点（UI の物がなければ null） */
  uiView: CameraView | null = null;

  /** UI の物の四角（直前に描いたときの） */
  uiRect(id: string): UiRect | undefined {
    return this.uiRects.get(id);
  }
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
  private textCache = new Map<string, Tex & { used: number; pad: number }>();
  /** 円の枠（太さの割合ごと） */
  private rings = new Map<number, Tex>();
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
  /** 前の draw の数（描く命令の回数・四角の数）。エディタの api.perf に出る */
  stats = { draws: 0, quads: 0 };

  draw(world: World, opts: DrawOptions | string): void {
    this.stats = { draws: 0, quads: 0 };
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
    // UI の物は、カメラに関係なく画面に固定して、カメラの後に描く
    const dw = o.design?.width ?? W, dh = o.design?.height ?? H;
    this.uiRects = layoutUI(world, dw, dh);
    const ui = all.filter((d) => d.e.c.UI);
    const world2 = ui.length ? all.filter((d) => !d.e.c.UI) : all;
    gl.enable(gl.SCISSOR_TEST);
    this.uiPass = false;
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
      for (const d of world2) {
        if (d.layer < cam.layerMin || d.layer > cam.layerMax) continue;
        this.drawOne(d.kind, d.e);
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
    this.uiView = null;
    if (this.uiRects.size) {
      // 設計の大きさの画面をそのまま映す視点（エディタの自由な視点なら、その視点）
      const view = o.view ?? defaultCamera(W, H, dw, dh);
      this.uiView = view;
      this.cam = view;
      this.camIndex = this.cams.indexOf(view);
      if (this.camIndex < 0) { this.cams.push(view); this.camIndex = this.cams.length - 1; }
      this.uiPass = true;
      for (const d of ui) if (this.uiRects.get(d.e.id)?.visible) this.drawOne(d.kind, d.e);
      this.flush();
      this.uiPass = false;
    }
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

  /** 読み込み中の画像・フォントがすべて終わるまで待つ（決まったフレームの画面を撮る前に。読めなかったものも終わりとみなす） */
  async settled(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      const n = this.textures.size + this.fontLoads.length;
      await Promise.all([...[...this.textures.values()].map((t) => t.loaded), ...this.fontLoads]);
      if (this.textures.size + this.fontLoads.length === n) return;
    }
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

  private drawOne(kind: string, e: Entity): void {
    const clip = e.c.Clip;
    const clipped = !!clip && clip.enabled !== false;
    if (clipped && !this.pushClip(clip.min ?? [0, 0], clip.max ?? [0, 0])) return;
    if (kind === 'sprite') this.sprite(e);
    else if (kind === 'shape') this.shape(e);
    else if (kind === 'particles') this.drawParticles(e);
    else if (kind === 'gauge') this.gauge(e);
    else this.text(e);
    if (clipped) this.popClip();
  }

  /** 切り抜き: この四角（ワールドの座標。UI なら画面の座標）の中だけに描く。何も見えないなら false */
  private pushClip(min: [number, number], max: [number, number]): boolean {
    const c = this.cam;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [wx, wy] of [[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]]) {
      const [sx, sy] = worldToScreen(c, wx, wy);
      x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
    }
    // カメラの範囲と重なる所だけ
    x0 = Math.max(x0, c.vx); y0 = Math.max(y0, c.vy); x1 = Math.min(x1, c.vx + c.vw); y1 = Math.min(y1, c.vy + c.vh);
    if (x1 <= x0 || y1 <= y0) return false;
    this.flush();
    const gl = this.gl;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.floor(x0), Math.floor(this.resH - y1), Math.ceil(x1 - x0), Math.ceil(y1 - y0));
    return true;
  }

  /** 切り抜きを外す（カメラの範囲の切り取りに戻す。UI なら切り取らない） */
  private popClip(): void {
    this.flush();
    const gl = this.gl, c = this.cam;
    if (this.uiPass) gl.disable(gl.SCISSOR_TEST);
    else gl.scissor(Math.floor(c.vx), Math.floor(this.resH - c.vy - c.vh), Math.ceil(c.vw), Math.ceil(c.vh));
  }

  /** UI の物は、その四角（中心・大きさ）で描く。Transform があれば回転・倍率だけ使う */
  private uiBox(e: Entity): { t: TransformLike; w: number; h: number; r: UiRect } | null {
    const r = e.c.UI ? this.uiRects.get(e.id) : undefined;
    if (!r) return null;
    const tr = e.c.Transform ?? {};
    return { t: { x: r.x + r.w / 2, y: r.y + r.h / 2, rot: tr.rot ?? 0, sx: tr.sx ?? 1, sy: tr.sy ?? 1 }, w: r.w, h: r.h, r };
  }

  /** ボタンの状態の色をかける */
  private stateColor(e: Entity, color: string): string {
    const b = e.c.Button;
    if (!b) return color;
    const k = b[b.state ?? 'normal'] ?? b.normal ?? '#ffffff';
    const [r1, g1, b1] = this.rgb(color), [r2, g2, b2] = this.rgb(k);
    const hx = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${hx(r1 * r2)}${hx(g1 * g2)}${hx(b1 * b2)}${color.length === 9 ? color.slice(7) : ''}`;
  }

  /** 四角の中の一部（0〜1 で指定）の4つの角。回転・倍率は中心まわり */
  private part(t: TransformLike, w: number, h: number, x0: number, y0: number, x1: number, y1: number): Corners {
    const sx = t.sx ?? 1, sy = t.sy ?? 1;
    const rad = ((t.rot ?? 0) * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
    const pt = (x: number, y: number): [number, number] => {
      const lx = (x - 0.5) * w * sx, ly = (y - 0.5) * h * sy;
      return [t.x + lx * c - ly * s, t.y + lx * s + ly * c];
    };
    return [...pt(x0, y0), ...pt(x1, y0), ...pt(x1, y1), ...pt(x0, y1)] as Corners;
  }

  private gauge(e: Entity): void {
    const g = e.c.Gauge;
    const box = this.uiBox(e);
    const t = box?.t ?? (e.c.Transform as TransformLike);
    const w = box?.w ?? g.w, h = box?.h ?? g.h;
    if (!t || w <= 0 || h <= 0) return;
    const k = Math.max(0, Math.min(1, (g.value ?? 0) / (g.max || 1)));
    const mat = this.material(e);
    const back = this.place(e.id, this.part(t, w, h, 0, 0, 1, 1));
    if (!back) return;
    if ((g.backAlpha ?? 1) > 0) this.quad(this.white, 'normal', back, 0, 0, 1, 1, this.stateColor(e, g.back), g.backAlpha ?? 1, mat);
    if (k <= 0) return;
    const [x0, y0, x1, y1] = g.dir === 'rightToLeft' ? [1 - k, 0, 1, 1] : g.dir === 'bottomToTop' ? [0, 1 - k, 1, 1] : g.dir === 'topToBottom' ? [0, 0, 1, k] : [0, 0, k, 1];
    const fill = this.place(e.id, this.part(t, w, h, x0, y0, x1, y1), false);
    if (fill) this.quad(this.white, 'normal', fill, 0, 0, 1, 1, this.stateColor(e, g.color), 1, mat);
  }

  private sprite(e: Entity): void {
    const s = e.c.Sprite;
    let t = e.c.Transform as TransformLike;
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
    // UI の物は四角いっぱいに描く
    const box = this.uiBox(e);
    if (box) { t = box.t; w = box.w; h = box.h; ax = ay = 0.5; }
    else if (s.slice > 0 && tex !== this.missing) {
      if (s.size?.[0] > 0) w = s.size[0];
      if (s.size?.[1] > 0) h = s.size[1];
    }
    const color = this.stateColor(e, s.tint ?? '#ffffff');
    if (s.slice > 0 && tex !== this.missing && w > 0 && h > 0) {
      // 9つに切って伸ばす: 四隅は元の大きさ、辺と真ん中を伸ばす
      const c = { x: t.x + (0.5 - ax) * w * (t.sx ?? 1), y: t.y + (0.5 - ay) * h * (t.sy ?? 1), rot: t.rot ?? 0, sx: t.sx ?? 1, sy: t.sy ?? 1 };
      const bx = Math.min(s.slice, w / 2) / w, by = Math.min(s.slice, h / 2) / h;
      const su = (s.slice / tex.w) * Math.sign(u1 - u0), sv = (s.slice / tex.h) * Math.sign(v1 - v0);
      const xs = [0, bx, 1 - bx, 1], ys = [0, by, 1 - by, 1];
      const us = [u0, u0 + su, u1 - su, u1], vs = [v0, v0 + sv, v1 - sv, v1];
      const outline = this.place(e.id, this.part(c, w, h, 0, 0, 1, 1));
      if (!outline) return;
      const mat = this.material(e, [u0, v0, u1, v1]);
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        const q = this.place(e.id, this.part(c, w, h, xs[i], ys[j], xs[i + 1], ys[j + 1]), false);
        if (q) this.quad(tex, s.blend ?? 'normal', q, us[i], vs[j], us[i + 1], vs[j + 1], color, s.alpha ?? 1, mat);
      }
      return;
    }
    const tile = s.tile as [number, number] | undefined;
    if (tile && tile[0] > 0 && tile[1] > 0 && tex !== this.missing && w > 0 && h > 0) {
      // 敷き詰める: 1枚の大きさ tile で size いっぱいに並べ、はみ出す所は絵を切る（帯のレーザー・流れる背景）。tileOffset で絵をずらす
      const c = { x: t.x + (0.5 - ax) * w * (t.sx ?? 1), y: t.y + (0.5 - ay) * h * (t.sy ?? 1), rot: t.rot ?? 0, sx: t.sx ?? 1, sy: t.sy ?? 1 };
      if (!this.place(e.id, this.part(c, w, h, 0, 0, 1, 1))) return;
      const [tw, th] = tile, [ox, oy] = (s.tileOffset as [number, number] | undefined) ?? [0, 0];
      const xs = tileSpans(w, tw, ox), ys = tileSpans(h, th, oy);
      const mat = this.material(e, [u0, v0, u1, v1]);
      const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
      for (const [y0, y1, ty0, ty1] of ys) for (const [x0, x1, tx0, tx1] of xs) {
        const q = this.place(e.id, this.part(c, w, h, x0, y0, x1, y1), false);
        if (!q) continue;
        let a0 = lerp(u0, u1, tx0), a1 = lerp(u0, u1, tx1), b0 = lerp(v0, v1, ty0), b1 = lerp(v0, v1, ty1);
        if (s.flipX) { a0 = lerp(u0, u1, 1 - tx0); a1 = lerp(u0, u1, 1 - tx1); }
        if (s.flipY) { b0 = lerp(v0, v1, 1 - ty0); b1 = lerp(v0, v1, 1 - ty1); }
        this.quad(tex, s.blend ?? 'normal', q, a0, b0, a1, b1, color, s.alpha ?? 1, mat);
      }
      return;
    }
    if (s.flipX) [u0, u1] = [u1, u0];
    if (s.flipY) [v0, v1] = [v1, v0];
    const q = this.place(e.id, cornersOf(t, w, h, ax, ay));
    if (q) this.quad(tex, s.blend ?? 'normal', q, u0, v0, u1, v1, color, s.alpha ?? 1, this.material(e, [u0, v0, u1, v1]));
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
    const s = e.c.Shape;
    const box = this.uiBox(e);
    const t = box ? box.t : (e.c.Transform as TransformLike);
    const color = this.stateColor(e, s.color), alpha = s.alpha ?? 1, mat = this.material(e);
    const blend = s.blend ?? 'normal';
    const [on, off] = (s.dash ?? [0, 0]) as [number, number], dashed = on > 0 && off > 0, offset = s.dashOffset ?? 0;
    // 一部だけ描く（破線の1本・塗り）。選ぶ範囲には入れない（選ぶのは図形の全体で）
    const piece = (tex: Tex, c: Corners, col = color) => { const p = this.place(e.id, c, false); if (p) this.quad(tex, blend, p, 0, 0, 1, 1, col, alpha, mat); };
    if (s.kind === 'line') {
      const to = (s.to ?? [0, 0]) as [number, number], width = s.stroke || 1;
      const q = this.place(e.id, lineCorners(t, to, width));
      if (!q) return;
      if (!dashed) this.quad(this.white, blend, q, 0, 0, 1, 1, color, alpha, mat);
      else for (const [a, b] of dashSpans(Math.hypot(to[0], to[1]), on, off, offset)) piece(this.white, lineCorners(t, to, width, a, b));
      return;
    }
    const w = box ? box.w : s.w, h = box ? box.h : s.h;
    const stroke = s.stroke ?? 0;
    const q = this.place(e.id, cornersOf(t, w, h, 0.5, 0.5));
    if (!q) return;
    if (stroke <= 0) { this.quad(s.kind === 'circle' ? this.circle : this.white, blend, q, 0, 0, 1, 1, color, alpha, mat); return; }
    // 中の塗り（枠の下に。円は枠の太さの真ん中まで塗って、すき間が出ないように）
    if (s.fill && this.alphaOf(s.fill) > 0) {
      const fc = this.stateColor(e, s.fill);
      if (s.kind === 'circle') piece(this.circle, cornersOf(t, Math.max(0, w - stroke), Math.max(0, h - stroke), 0.5, 0.5), fc);
      else if (stroke * 2 < Math.min(w, h)) piece(this.white, this.part(t, w, h, stroke / w, stroke / h, 1 - stroke / w, 1 - stroke / h), fc);
    }
    if (s.kind === 'circle') {
      if (!dashed) { this.quad(this.ring(stroke / Math.max(1, Math.min(w, h) / 2)), blend, q, 0, 0, 1, 1, color, alpha, mat); return; }
      // 破線の円: 模様を円周に沿って置き、1本を細かい台形に分けて描く（上から時計回り）
      const sw = Math.min(stroke, w / 2, h / 2);
      for (const [a, b] of dashSpans(ellipsePerimeter(w / 2 - sw / 2, h / 2 - sw / 2), on, off, offset)) {
        const n = Math.max(1, Math.ceil(((b - a) * Math.PI * 2) / 0.15));
        for (let i = 0; i < n; i++) {
          const a0 = -Math.PI / 2 + Math.PI * 2 * (a + ((b - a) * i) / n), a1 = -Math.PI / 2 + Math.PI * 2 * (a + ((b - a) * (i + 1)) / n);
          piece(this.white, ringPiece(t, w, h, sw, a0, a1));
        }
      }
      return;
    }
    for (const [x0, y0, x1, y1] of dashed ? dashedBands(w, h, stroke, on, off, offset) : strokeBands(w, h, stroke)) piece(this.white, this.part(t, w, h, x0, y0, x1, y1));
  }

  /** 円の枠の絵（太さは半径に対する割合。1/64 刻みで作り置く） */
  private ring(ratio: number): Tex {
    const k = Math.max(1, Math.min(64, Math.round(ratio * 64)));
    let tex = this.rings.get(k);
    if (!tex) {
      const R = 128, lw = (k / 64) * R;
      tex = this.fromCanvas(this.makeCanvas(R * 2, R * 2, (g) => {
        g.strokeStyle = '#fff';
        g.lineWidth = lw;
        g.beginPath();
        g.arc(R, R, Math.max(0.5, R - lw / 2 - 1), 0, Math.PI * 2);
        g.stroke();
      }), 'linear');
      this.rings.set(k, tex);
    }
    return tex;
  }

  private text(e: Entity): void {
    const tx = e.c.Text;
    let t = e.c.Transform as TransformLike;
    if (!tx.text) return;
    const font = `${tx.bold ? 'bold ' : ''}${Math.round(tx.size)}px ${tx.font ? this.fontFamily(tx.font) : 'system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif'}`;
    const wrap = tx.wrap > 0 ? tx.wrap : 0, lhk = tx.lineHeight || 1.25;
    // 縁取りは絵の中に色ごと描く（縁と文字の色が違うので、描くときに色をかけない）
    const ol = tx.outline > 0 ? tx.outline : 0;
    const key = `${font}|${wrap}|${lhk}|${ol ? `${ol}|${tx.outlineColor}|${tx.color}` : ''}|${tx.text}`;
    let tex = this.textCache.get(key);
    if (!tex) {
      this.measure.font = font;
      const lines = String(tx.text).split('\n').flatMap((l) => (wrap ? this.wrapLine(l, wrap) : [l]));
      const w = Math.max(1, Math.ceil(Math.max(...lines.map((l) => this.measure.measureText(l).width))) + 4);
      const lh = Math.ceil(tx.size * lhk);
      const pad = Math.ceil(ol);
      const c = this.makeCanvas(w + pad * 2, lh * lines.length + pad * 2, (g) => {
        g.font = font;
        g.textBaseline = 'middle';
        if (ol) {
          g.lineJoin = 'round';
          g.lineWidth = ol * 2;
          g.strokeStyle = tx.outlineColor || '#000000';
          lines.forEach((l, i) => g.strokeText(l, 2 + pad, pad + lh * (i + 0.5)));
        }
        g.fillStyle = ol ? tx.color || '#ffffff' : '#fff';
        lines.forEach((l, i) => g.fillText(l, 2 + pad, pad + lh * (i + 0.5)));
      });
      tex = { ...this.fromCanvas(c, 'linear'), used: 0, pad };
      this.textCache.set(key, tex);
    }
    tex.used = this.frameNo;
    const ax = tx.align === 'center' ? 0.5 : tx.align === 'right' ? 1 : 0;
    // UI の物は、四角の中で揃える（縦は真ん中）
    const box = this.uiBox(e);
    if (box) t = { ...box.t, x: box.t.x + (ax - 0.5) * box.w * (box.t.sx ?? 1) };
    // 縁取りの余白を除いた文字の四角で揃える
    const ix = (tex.pad + ax * (tex.w - tex.pad * 2)) / tex.w;
    const q = this.place(e.id, cornersOf(t, tex.w, tex.h, ix, 0.5));
    if (q) this.quad(tex, 'normal', q, 0, 0, 1, 1, this.stateColor(e, ol ? '#ffffff' : tx.color), tx.alpha ?? 1, this.material(e));
  }

  /** 1行を幅で折り返す（英語は単語の切れ目で、日本語は文字ごとに） */
  private wrapLine(line: string, width: number): string[] {
    const out: string[] = [];
    let cur = '';
    for (const ch of line) {
      const next = cur + ch;
      if (cur && this.measure.measureText(next).width > width) {
        const sp = cur.lastIndexOf(' ');
        if (ch !== ' ' && sp > 0 && /[\x21-\x7e]$/.test(cur)) { out.push(cur.slice(0, sp)); cur = cur.slice(sp + 1) + ch; }
        else { out.push(cur); cur = ch === ' ' ? '' : ch; }
      } else cur = next;
    }
    out.push(cur);
    return out;
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
    if (color.length === 9) alpha *= this.alphaOf(color);
    const o = this.count * 4 * FLOATS;
    const uv = [u0, v0, u1, v0, u1, v1, u0, v1];
    for (let i = 0; i < 4; i++) {
      this.verts.set([q[i * 2], q[i * 2 + 1], uv[i * 2], uv[i * 2 + 1], r, g, b, alpha], o + i * FLOATS);
    }
    this.count++;
  }

  private flush(): void {
    if (!this.count || !this.curTex) { this.count = 0; return; }
    this.stats.draws++;
    this.stats.quads += this.count;
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
  /** 読み込み中のフォント（settled で待つ） */
  private fontLoads: Promise<void>[] = [];
  private fontFamily(path: string): string {
    let fam = this.fonts.get(path);
    if (fam) return fam;
    fam = `ages-font-${this.fonts.size}`;
    this.fonts.set(path, fam);
    // 名前に ' や空白があっても読めるように、場所を引用符で囲む
    const face = new FontFace(fam, `url(${JSON.stringify(this.opts.urlOf(path))})`);
    this.fontLoads.push(face.load().then((f) => {
      document.fonts.add(f);
      for (const [k, t] of this.textCache) if (k.includes(fam!)) { this.gl.deleteTexture(t.tex); this.textCache.delete(k); }
    }).catch(() => console.warn(`フォントを読み込めません: ${path}`)));
    return fam;
  }

  /** 色の透け具合（#rrggbbaa の aa。#rrggbb なら 1） */
  private alphaOf(hex: string): number {
    return hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 || 0 : 1;
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
