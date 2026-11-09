// プロジェクト独自のエディタ拡張（editor/*.window.ts・editor/*.ext.ts）が使う API。
// Unity の EditorWindow（パネル）・PropertyDrawer（インスペクタの欄）・CustomEditor（部品の見せ方）にあたる。
// AIに「この調整用の画面を作って」と頼めば、この API で書ける。エディタ本体の機能（UI の「端に付ける」など）も同じ API で作っている。
// 拡張は隔離しない（エディタと同じページで動く）。よく使うことはここに窓口として用意し、足りないときだけ中身を直接触る。
import type { Op, Change } from '../core/patch.ts';
import type { PrefabDoc, ProjectConfig, SceneDoc } from '../core/docs.ts';
import type { GameEvent } from '../core/game.ts';
import type { Field } from '../core/schema.ts';
import type { SheetDef } from '../core/sheet.ts';

export interface EditorApi {
  /** 現在のプロジェクトの内容（読み取り専用として扱う）。プレハブはファイルの中身（派生は元からの差。元と重ねた値は get で読む） */
  readonly state: {
    config: ProjectConfig;
    scenes: Record<string, SceneDoc>;
    prefabs: Record<string, PrefabDoc>;
    locks: Record<string, { who: string; t: string; value: unknown; note?: string }>;
    touched: Record<string, { who: string; t: string }>;
  };
  /** エディタを使っている人の名前 */
  readonly user: string;
  readonly playing: boolean;
  /** 値を変える。操作ログには「window:<id>」から人が変更したと記録される。変えられるのは edits と、この拡張が見せている欄・部品だけ */
  patch(ops: Op[]): Promise<Change[] | null>;
  /** アドレスの値を読む（例: main#spawner.Spawner.interval）。省略されていれば既定値、派生のプレハブなら元から受け継いだ値 */
  get(path: string): unknown;
  /** インスペクタで選ぶ（例: main#player / @enemy） */
  select(address: string): void;
  /** 画面なしで試し実行する。keys は ages run --keys と同じ書き方（"0-600:@fire;100-200:ArrowLeft"） */
  simulate(frames: number, keys?: string, seed?: number): { counts: Record<string, number>; frame: number; ms: number };
  /** 画像の切り方（コマ・動き）。切っていなければ undefined */
  sheet(image: string): SheetDef | undefined;
  /** 通知（画面の右下に少しのあいだ出る）。kind: info（既定）・warn・bad */
  notify(text: string, kind?: 'info' | 'warn' | 'bad'): void;
  on(event: 'change' | 'select' | 'play' | 'frame', fn: () => void): () => void;
  on(event: 'gameEvent', fn: (ev: GameEvent) => void): () => void;
  /** DOMを作る小さなヘルパー: h('div', { class: 'x', onclick }, '中身', ...) */
  h: (tag: string, attrs?: Record<string, unknown>, ...children: unknown[]) => HTMLElement;
}

/** インスペクタの1つの欄（拡張が見せ方を差し替えるときに渡る） */
export interface FieldView {
  /** 欄の住所（例 main#spawner.Spawner.interval・@enemy.Health.hp） */
  readonly path: string;
  readonly component: string;
  readonly field: string;
  /** 型・範囲・既定値・説明 */
  readonly def: Field;
  /** 今の値（省略されていれば既定値、派生なら受け継いだ値） */
  readonly value: unknown;
  /** 書いていない（既定値・受け継いだ値） */
  readonly isDefault: boolean;
  /** 🔒 ロックされている（見せるだけ。set は効かない） */
  readonly locked: boolean;
  readonly playing: boolean;
  /** 同じ物のほかの部品の値（読み取り専用。例 holder.Sprite.image） */
  readonly holder: Record<string, Record<string, unknown>>;
  /** この欄の値を変える。final=false は途中（ドラッグ中など。再生中の画面にだけ反映して、保存しない） */
  set(value: unknown, final?: boolean): void;
  /** 標準の入力欄を作る（中に並べて使うとき） */
  standard(): HTMLElement;
}

/** インスペクタの欄の見せ方（Unity の PropertyDrawer） */
export interface FieldDrawer {
  /**
   * どの欄に使うか。型（例 'color'）・部品.フィールド（例 'Spawner.formation'）・住所（例 'main#spawner.Spawner.formation'）。
   * 並べると複数。重なったら 住所 → 部品.フィールド → 型 の順に、細かいものが使われる
   */
  match: string | string[];
  /** el に欄の中身を作る。後片付けが要るなら関数を返す */
  mount(el: HTMLElement, field: FieldView, api: EditorApi): void | (() => void);
}

/** インスペクタの部品の見せ方（Unity の CustomEditor）。部品の欄の上に、拡張の中身を足す */
export interface ComponentDrawer {
  /** 部品の名前（例 'Spawner'） */
  component: string;
  /** 標準の欄を隠す: 'all' か、フィールドの名前の並び */
  hide?: 'all' | string[];
  mount(el: HTMLElement, comp: ComponentView, api: EditorApi): void | (() => void);
}

export interface ComponentView {
  /** 部品を持っている物（main#player・@enemy） */
  readonly target: string;
  readonly component: string;
  /** 既定値で埋めた今の値（派生なら元と重ねた値） */
  readonly values: Record<string, unknown>;
  readonly playing: boolean;
  /** 変えられる（再生中・保存できない物なら false） */
  readonly editable: boolean;
  /** 同じ物のほかの部品の値（読み取り専用） */
  readonly holder: Record<string, Record<string, unknown>>;
  locked(field: string): boolean;
  /** この部品の値を1つ変える */
  set(field: string, value: unknown): void;
}

/** エディタ拡張。窓口（panel・fields・components）は要る分だけ書く */
export interface EditorExtension {
  /** 英数字・_・- （操作ログには window:<id> と残る） */
  id: string;
  /** パネルのタブの名前（パネルがあるとき） */
  title?: string;
  /** 何のための拡張か（1行。地図に出る。AI が同じものを作らないように） */
  desc?: string;
  /**
   * パネルが変える値の住所（地図に出る）。書いたら、それ以外は変えられない。欄・部品の見せ方は、その欄・部品なら書かなくても変えられる。
   * 例: 'main#spawner.Spawner.interval'、中をまとめて 'main#spawner.Spawner.*'、'@enemy.*'、'$enemies.*'。ロックされた値は変えられない
   */
  edits?: string[];
  /** パネル（Unity の EditorWindow） */
  panel?: {
    title?: string;
    /** 最初に置く場所（既定: 下） */
    area?: 'left' | 'center' | 'bottom' | 'right';
    mount(el: HTMLElement, api: EditorApi): void | (() => void);
  };
  /** インスペクタの欄の見せ方 */
  fields?: FieldDrawer[];
  /** インスペクタの部品の見せ方 */
  components?: ComponentDrawer[];
}

/** パネルだけの拡張の、短い書き方（これまでの書き方） */
export interface EditorWindow {
  id: string;
  title: string;
  desc?: string;
  edits?: string[];
  /** el に中身を作る。後片付けが必要なら関数を返す */
  mount(el: HTMLElement, api: EditorApi): void | (() => void);
}

export function defineExtension(x: EditorExtension): EditorExtension {
  return x;
}

export function defineWindow(w: EditorWindow): EditorWindow {
  return w;
}

/** defineWindow の形も、拡張の形にそろえる */
export function asExtension(x: EditorExtension | EditorWindow): EditorExtension {
  if ('mount' in x && typeof x.mount === 'function') {
    const w = x as EditorWindow;
    return { id: w.id, title: w.title, desc: w.desc, edits: w.edits, panel: { title: w.title, mount: w.mount } };
  }
  return x as EditorExtension;
}

/** 欄の見せ方の match の、細かさ（住所 3・部品.フィールド 2・型 1） */
export function matchRank(m: string): number {
  return m.includes('#') || m.startsWith('@') ? 3 : m.includes('.') ? 2 : 1;
}

/** 欄の見せ方の match が、この欄に当たるか */
export function matchField(m: string, path: string, component: string, field: string, type: string): boolean {
  const r = matchRank(m);
  return r === 3 ? m === path : r === 2 ? m === `${component}.${field}` : m === type;
}
