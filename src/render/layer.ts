// 2D の描画（webgl.ts）の下に、別の描き方の層を入れる窓口（追加パッケージ 3d の 3D など）。
// 層は背景を塗った直後・2D の物を描く前に呼ばれる。GL の状態は自由に変えてよい（呼んだ後で 2D の状態に戻す）。
// ただし、描く先（framebuffer）と pixelStorei は、変えたら戻すこと
import type { World } from '../core/world.ts';

export interface LayerHost {
  gl: WebGL2RenderingContext;
  /** アセットの場所（assets/a.png）から読み込む URL */
  urlOf(path: string): string;
}

export interface LayerFrame {
  world: World;
  /** 描く先の大きさ（px） */
  width: number;
  height: number;
  /** 描く先（null は画面） */
  framebuffer: WebGLFramebuffer | null;
  /** 背景の色（#rrggbb） */
  background: string;
  /** この層への指示（DrawOptions.layers[層の名前]。エディタの自由な視点など） */
  options?: unknown;
}

export interface RenderLayer {
  name: string;
  draw(frame: LayerFrame): void;
  /**
   * 時間を進める（粒など、描く側だけの動き。dt 秒）。previewIds は編集中に選んでいる物（ゲームを動かしていないとき）
   */
  update?(world: World, dt: number, previewIds?: string[]): void;
  /** アセットが変わった（path を省くと全部）。読み直す */
  invalidate?(path?: string): void;
  /** 読み込み中のもの（画像・モデル）が読み込み終わるまで待つ（画面を撮る前に） */
  settled?(): Promise<void>;
  /** 前の draw で描いた命令の回数 */
  draws?: number;
}
