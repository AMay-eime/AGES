// プロジェクト独自のエディタ拡張（editor/*.window.ts・editor/*.ext.ts）が使う API。
// Unity の EditorWindow（パネル）・PropertyDrawer（インスペクタの欄）・CustomEditor（部品の見せ方）にあたる。
// AIに「この調整用の画面を作って」と頼めば、この API で書ける。エディタ本体の機能（UI の「端に付ける」など）も同じ API で作っている。
// 拡張は隔離しない（エディタと同じページで動く）。よく使うことはここに窓口として用意し、足りないときだけ中身を直接触る。
import type { Op, Change } from '../core/patch.ts';
import type { PrefabDoc, ProjectConfig, SceneDoc } from '../core/docs.ts';
import type { Game, GameEvent } from '../core/game.ts';
import type { ComponentDef } from '../core/schema.ts';
import type { TableDef } from '../core/table.ts';
import type { TrialResult } from '../core/trial.ts';
import type { Field } from '../core/schema.ts';
import type { SheetDef } from '../core/sheet.ts';
import type { TableDoc, TableView } from '../core/table.ts';

export interface EditorApi {
  /** 現在のプロジェクトの内容（読み取り専用として扱う）。プレハブはファイルの中身（派生は元からの差。元と重ねた値は get で読む） */
  readonly state: {
    config: ProjectConfig;
    scenes: Record<string, SceneDoc>;
    prefabs: Record<string, PrefabDoc>;
    /** 表の中身（ファイルの中身。省いた列は既定値で埋まっていない。埋めた形は table で読む） */
    tables: Record<string, TableDoc>;
    /** プロジェクトのアセット（画像は w・h、音は sec） */
    assets: { path: string; kind: string; bytes: number; w?: number; h?: number; sec?: number }[];
    /** 検証の ⚠（ages check と同じ） */
    issues: string[];
    locks: Record<string, { who: string; t: string; value: unknown; note?: string }>;
    touched: Record<string, { who: string; t: string }>;
  };
  /** エディタを使っている人の名前 */
  readonly user: string;
  readonly playing: boolean;
  /**
   * 値を変える。操作ログには「window:<id>」から人が変更したと記録される。変えられるのは edits と、この拡張が見せている欄・部品だけ。
   * 1つずつ順に送る。ops を関数で渡すと、前の変更が終わった後に呼ぶ（その時の api.get・api.table で作る。続けてのクリックで古い値から作らないように）
   */
  patch(ops: Op[] | (() => Op[])): Promise<Change[] | null>;
  /** アドレスの値を読む（例: main#spawner.Spawner.interval・$enemies.basic.hp）。省略されていれば既定値、派生のプレハブなら元から受け継いだ値 */
  get(path: string): unknown;
  /** 表を読む（省いた列は既定値で埋めた行。ゲームのコードの ctx.table と同じ。変えるのは patch の set・addRow など） */
  table(name: string): TableView;
  /** 選ぶ（例: main#player / @enemy をインスペクタで、$bullets.shot1 は表のエディタをその行で開く）。add なら今の選びに足す（シーンの物だけ）。null で選ぶのをやめる */
  select(address: string | null, add?: boolean): void;
  /**
   * 再生する（エディタの ▶ と同じ）。scene・params・date で始め方を選べる（省くと今のシーンを、再生の設定で）。再生中なら何もしない。
   * 例 ステージを試す: api.play({ scene: 'battle', params: { stage: 'stage_0001' } })。止めると始めたシーンに戻る。ゲームの画面を前に出す（show: false で出さない）
   */
  play(opts?: { scene?: string; params?: Record<string, unknown>; date?: string; show?: boolean }): void;
  /** 再生を止める（実行中の変更を保存するかは人に尋ねる） */
  stop(): Promise<void>;
  /** 画面なしで試し実行する。keys は ages run --keys と同じ書き方（"0-600:@fire;100-200:ArrowLeft"） */
  simulate(frames: number, keys?: string, seed?: number): { counts: Record<string, number>; frame: number; ms: number };
  /** アセットの URL（img の src・CSS の url() に。ファイルが変わると URL も変わる） */
  assetUrl(path: string): string;
  /** 画像の切り方（コマ・動き）。切っていなければ undefined */
  sheet(image: string): SheetDef | undefined;
  /** 通知（画面の右下に少しのあいだ出る）。kind: info（既定）・warn・bad */
  notify(text: string, kind?: 'info' | 'warn' | 'bad'): void;
  /** いま選んでいる物の住所（main#player・@enemy・表のエディタで選んだ行は $表.行）。選んでいなければ null。いくつも選んでいるときは、インスペクタに出ている物 */
  readonly selection: string | null;
  /** いま選んでいる物すべての住所（手前の物が最初） */
  readonly selected: string[];
  /** 1行の文字を尋ねる（やめたら null） */
  ask(title: string, value?: string): Promise<string | null>;
  /**
   * インスペクタと同じ標準の欄を作る（パネルの中で使う）。型から作る: 数（範囲があればドラッグ）・選択・プレハブ・アセット・表の行・色・入れ子（リスト・構造体・どれか1つ）など。
   * onChange(値, final): final=false は途中（ドラッグ中）。値を変えるのは onChange の中で api.patch。拡張の欄の見せ方は使わない。
   * 例: api.input({ type: 'prefab', default: '', tags: ['stage'] }, cur, (v, final) => { if (final) api.patch([{ op: 'set', path, value: v }]); })
   */
  input(field: Field, value: unknown, onChange: (value: unknown, final: boolean) => void): HTMLElement;
  /**
   * 試しの舞台: el に小さな画面を作り、シーン（scene）か、空のシーンに出したプレハブ（spawn）を、くり返し動かす（エディタの「試し」の窓もこれで作っている）。
   * ゲームと同じ決まりで動く。音は鳴らさず、数だけを onCycle で返す。時間の操作・描き込み・取っ手は返す StageHandle で
   */
  stage(el: HTMLElement, opts: StageOptions): StageHandle;
  /**
   * 画面なしで動かして中を読む（少しずつ回すので画面は固まらない）。指定の誤り（ないシーン・物）は失敗、ゲームのコードのエラーは結果の error。
   * 例 const r = await api.run({ scene: 'battle', params: { stage: 's1' }, frames: 28800, onFrame: (g) => …, until: (g) => … })
   */
  run(opts: RunOptions): Promise<RunResult>;
  // ---- 再生中のゲーム・保存データ・形・窓（デバッグの道具など） ----
  /**
   * 再生中のゲーム（止めていれば null）。world・ctx・frame・sceneName を読める。ctx.emit で出来事を送れる（on が受ける）。
   * 値を書くと、その場のゲームに効く（ファイルには保存しない。止めたときの「実行中の変更を保存するか」にも入らない）
   */
  readonly game: Game | null;
  /** 再生の一時停止（true で止める・false で進める。省くと切り替え） */
  pause(paused?: boolean): void;
  /** frames だけ進める（止めてから。再生していなければ始めて止める） */
  step(frames?: number): void;
  /** 再生の速さ（1 が実時間。0.1〜8） */
  speed: number;
  /** 保存データ（再生中ならそのゲームの ctx.save と同じもの。止めていれば、このブラウザの保存データ＝次の再生で読まれるもの） */
  readonly save: { read(key: string): unknown; write(key: string, value: unknown): void; delete(key: string): void; keys(): string[] };
  /** 部品の形（'Health'）・表の形（'$enemies'）。フィールドの型・範囲・説明。なければ undefined */
  schema(name: string): ComponentDef | TableDef | undefined;
  /** 窓を出す（build が中身を作る。close で閉じる） */
  modal(build: (close: () => void) => HTMLElement): void;
  /** 拡張のパネルを前に出し、args を渡す（受け手の拡張は api.on('show', fn) で受ける。拡張どうしの呼び出し。例 射撃パターンのパネルを、その名前で開く） */
  show(extId: string, args?: unknown): boolean;
  /** ドラッグで運ばれてくる物の dataTransfer の型（asset: アセットの場所・prefab: プレハブの名前）。パネルに落とせるようにするとき */
  readonly dragTypes: { asset: string; prefab: string };
  on(event: 'change' | 'select' | 'play' | 'frame', fn: () => void): () => void;
  on(event: 'gameEvent', fn: (ev: GameEvent) => void): () => void;
  /** 再生中にシーンが切り替わったとき */
  on(event: 'scene', fn: (ev: { from: string; to: string }) => void): () => void;
  /** show で呼ばれたとき（この拡張あて） */
  on(event: 'show', fn: (args: unknown) => void): () => void;
  /** DOMを作る小さなヘルパー: h('div', { class: 'x', onclick }, '中身', ...) */
  h: (tag: string, attrs?: Record<string, unknown>, ...children: unknown[]) => HTMLElement;
}

// ---------- 試しの舞台（api.stage）と画面なしの実行（api.run） ----------

/** 何を動かすか（舞台と api.run で同じ）。日時は省くと決まった日時なので、同じ指定なら毎回同じ結果 */
export interface RunSpec {
  /** 動かすシーン（例 'battle'）。書いたら spawn は省ける */
  scene?: string;
  /** 始めのシーンに渡す ctx.scene.params（例 { stage: 'stage_0001' }） */
  params?: Record<string, unknown>;
  /** シーンの物の値の上書き（保存しない）: { 物のID: { 部品: { フィールド: 値 } } }。例 { battle: { Battle: { difficulty: 3 } } }。シーンに入り直すと元の値 */
  values?: Record<string, Record<string, Record<string, unknown>>>;
  /** 出すプレハブ。x・y は画面（設計の大きさ）の真ん中からのずれ(px)、values は出すときに変える値。scene がなければ空のシーンに出す */
  spawn?: { prefab: string; x?: number; y?: number; values?: Record<string, Record<string, unknown>> }[];
  /** ctx.date の始め（'2026-12-25T09:00'。省くと ages run と同じ決まった日時） */
  date?: string;
  seed?: number;
  /** 入力（ages run --keys と同じ書き方。例 "0-60:@fire"・"battle+30:click=start"） */
  keys?: string;
}

export interface RunOptions extends RunSpec {
  /** 最大のフレーム数（既定 600。240秒は fps×240） */
  frames?: number;
  /** フレームを進めるたびに（例 出した物の位置を記録する。ids は spawn で出した物の ID） */
  onFrame?(game: Game, ids: string[]): void;
  /** 出来事が出るたびに（中身の data も。例 stageElement の番号と時刻） */
  onEvent?(ev: GameEvent): void;
  /** true を返したら止める */
  until?(game: Game): boolean;
  /** やめる（結果の stopped が aborted） */
  signal?: AbortSignal;
}

/** api.run の結果。stopped: frames（数だけ回した）・until・gone（spawn で出した物がすべて消えた）・aborted・error */
export type RunResult = TrialResult;

export interface StageOptions extends RunSpec {
  /** 1回の長さ（秒。既定 spawn だけなら 3、scene なら切らない）。spawn で出した物がすべて消えたら、その時点で回の終わり */
  seconds?: number;
  /** 回が終わったら最初からくり返す（既定 true）。false なら終わりで止まる（playing が false に） */
  loop?: boolean;
  /** プロジェクトの値が変わったとき（set で動かし方を変えたときも）: restart 最初から（既定）・keepTime 作り直して同じフレームまで進める・none 作り直さない */
  onChange?: 'restart' | 'keepTime' | 'none';
  /** 速さ（既定 1） */
  speed?: number;
  /** 拡大（scene がないときの試しのカメラ。既定 2） */
  zoom?: number;
  /** 試しのカメラで最初に出した物を追いかける（既定 false） */
  follow?: boolean;
  /** 画面の大きさ(px)。既定 spawn だけなら 240x150。scene・自由な視点では幅 320・高さは設計の縦横比で、設計の画面（view）を縮めて入れる */
  width?: number;
  height?: number;
  /**
   * 見え方。free: カメラに合わせず、設計の画面全体が入る大きさを 1 として zoom 倍（0.7 なら画面の外も見える。x・y は真ん中のワールドの座標）。
   * 自由な視点ではホイールで拡大・右ドラッグで移動。frame: プレイヤーに見える画面の枠を点線で（自由な視点なら既定 true）
   */
  view?: { free?: boolean; zoom?: number; x?: number; y?: number; frame?: boolean };
  /** scene をカメラの視点で描くときの細かさ（設計の大きさに対する倍率。既定 1。重いシーンは 0.5 などにすると軽い） */
  resolution?: number;
  /** 当たり判定（Collider）を重ねて描く（ゲームの画面の「当たり判定」と同じ描き方） */
  colliders?: boolean;
  /** 1回終わるごとに呼ぶ（その回の数） */
  onCycle?(summary: StageSummary): void;
}

export interface StageSummary {
  /** その回に進めたフレーム数 */
  frames: number;
  /** 出した物がすべて消えたか（でなければ時間切れ） */
  gone: boolean;
  sounds: Record<string, number>;
  particles: Record<string, number>;
  events: Record<string, number>;
  warnings: string[];
  /** 動かせなかった理由（ゲームのコードのエラーなど） */
  error?: string;
}

export interface StageHandle {
  /** 設定を変える。動かし方（scene・params・values・spawn・keys など）が変わったら onChange に従って作り直す */
  set(opts: Partial<StageOptions>): void;
  /** すぐ最初から */
  restart(): void;
  /** 止めて片付ける */
  destroy(): void;
  /** 動いているか。false で一時停止、true で続き（回の終わりで止まっていたら最初から） */
  playing: boolean;
  /** 一時停止して frames（既定 1）だけ進める（多いときは seek） */
  step(frames?: number): void;
  /** その秒のフレームへ（前なら作り直して進める）。少しずつ回すので画面は固まらない。着いたら解決（次の seek・restart でも解決） */
  seek(seconds: number): Promise<void>;
  /** 今のフレーム・秒（作れていなければ 0） */
  readonly frame: number;
  readonly time: number;
  /** 動いているゲーム（作れなかったら null）。world・ctx・frame を読める。作り直すと別の物になる */
  readonly game: Game | null;
  /** 出来事を送る（ctx.emit と同じ。defineSystem の on が受ける）。作り直すと消える */
  send(event: string, data?: unknown): void;
  /** フレームを進めるたびに（シークの早送りでも）。外す関数を返す */
  onFrame(fn: (game: Game) => void): () => void;
  /** 描くたびに、ワールドの座標(px)で描き込む（舞台のカメラ・縮小に合う）。外す関数を返す */
  draw(fn: (g: StageDraw, view: StageView) => void): () => void;
  /** 舞台の上のマウス。down で true を返すと、その押しを使った（自由な視点の移動をしない）。外す関数を返す */
  onPointer(fn: (ev: StagePointer) => boolean | void): () => void;
  /** 画面の点（clientX・clientY）→ ワールドの座標。舞台がまだ描けていなければ null */
  toWorld(clientX: number, clientY: number): [number, number] | null;
  /** ワールドの座標 → 画面の点（clientX・clientY） */
  toScreen(x: number, y: number): [number, number] | null;
}

/** 描き込みの見た目。大きさ・太さは画面の px（px: true なら円の r・四角の w・h も） */
export interface DrawStyle {
  /** 線の色（既定 白。'none' で線なし）。#rrggbbaa も使える */
  color?: string;
  /** 塗りの色（既定 塗らない。文字では使わない） */
  fill?: string;
  /** 線の太さ（画面の px。既定 1.5） */
  width?: number;
  /** 透け具合（0〜1。既定 1） */
  alpha?: number;
  /** 破線（画面の px。例 [6, 4]） */
  dash?: number[];
  /** 円の r・四角の w・h を画面の px で数える（拡大しても同じ大きさ。取っ手の○・□に） */
  px?: boolean;
  /** 四角の x・y を真ん中として数える */
  center?: boolean;
  /** 線を閉じる（polyline） */
  closed?: boolean;
  /** 文字の大きさ（画面の px。既定 11）と揃え（既定 left。縦は真ん中） */
  size?: number;
  align?: 'left' | 'center' | 'right';
}

/** 舞台への描き込み（座標はワールドの px） */
export interface StageDraw {
  circle(x: number, y: number, r: number, style?: DrawStyle): void;
  rect(x: number, y: number, w: number, h: number, style?: DrawStyle): void;
  line(x1: number, y1: number, x2: number, y2: number, style?: DrawStyle): void;
  /** points は [x0, y0, x1, y1, …] */
  polyline(points: number[], style?: DrawStyle): void;
  text(x: number, y: number, text: string, style?: DrawStyle): void;
}

/** 描き込むときの様子 */
export interface StageView {
  readonly game: Game;
  readonly frame: number;
  readonly time: number;
  /** ワールドの 1px が画面の何 px か（取っ手の当たりの大きさを、ワールドに直すときに） */
  readonly scale: number;
  /** 見えているワールドの範囲 */
  readonly visible: { x: number; y: number; w: number; h: number };
  /** プレイヤーに見える画面の枠（ワールドの4つの角 [x0,y0,…,x3,y3]。カメラごと。spawn だけなら設計の画面） */
  readonly screens: number[][];
}

/** 舞台の上のマウス */
export interface StagePointer {
  type: 'down' | 'move' | 'up' | 'leave';
  /** ワールドの座標 */
  x: number;
  y: number;
  /** 0 左・1 中・2 右 */
  button: number;
  /** 押しているボタン（1 左・2 右・4 中の和） */
  buttons: number;
  shift: boolean;
  /** Ctrl（Mac は ⌘ も） */
  ctrl: boolean;
  alt: boolean;
  /** 元の出来事（カーソルを変えるなら native.target の style.cursor） */
  native: PointerEvent;
}

/** インスペクタ・表のエディタの1つの欄（拡張が見せ方を差し替えるときに渡る）。入れ子の中の欄にも渡る */
export interface FieldView {
  /** 欄の住所（例 main#spawner.Spawner.interval・@enemy.Enemy.shotPatterns[2].pattern・$talks.t1.lines[0].face） */
  readonly path: string;
  /** 部品の名前（表の欄なら ''） */
  readonly component: string;
  /** フィールドの名前（表の欄なら列の名前。入れ子の中の欄なら、一番外のフィールド） */
  readonly field: string;
  /** 入れ子の中の場所（一番外の欄なら []。例 [2, 'pattern']） */
  readonly sub: (string | number)[];
  /** 入れ子の中の欄なら、すぐ外の値（構造体・どれか1つ・リスト。読み取り専用。例 parent.enabled で中を畳む） */
  readonly parent?: unknown;
  /** 表の欄なら、その行（既定値で埋めた値。読み取り専用） */
  readonly row?: { table: string; id: string; values: Record<string, unknown> };
  /** 型・範囲・既定値・説明 */
  readonly def: Field;
  /** 今の値（省略されていれば既定値、派生なら受け継いだ値） */
  readonly value: unknown;
  /** 書いていない（既定値・受け継いだ値） */
  readonly isDefault: boolean;
  /** 🔒 ロックされている（見せるだけ。set は効かない） */
  readonly locked: boolean;
  readonly playing: boolean;
  /** 同じ物のほかの部品の値（読み取り専用。例 holder.Sprite.image。表の欄なら {}） */
  readonly holder: Record<string, Record<string, unknown>>;
  /** この欄の値を変える。final=false は途中（ドラッグ中など。再生中の画面にだけ反映して、保存しない） */
  set(value: unknown, final?: boolean): void;
  /** 標準の入力欄を作る（中に並べて使うとき） */
  standard(): HTMLElement;
  /** この欄を名前の行ごと隠す（ほかの値によって要らない欄。例 狙い方に合わない角度） */
  hide(): void;
}

/** インスペクタ・表のエディタの欄の見せ方（Unity の PropertyDrawer） */
export interface FieldDrawer {
  /**
   * どの欄に使うか。型（例 'color'）・部品.フィールド（例 'Spawner.formation'）・$表.列（例 '$talks.face'。どの行にも）・住所（例 'main#spawner.Spawner.formation'）。
   * 入れ子の中は、リストの項目を []、構造体の中を .名前 で（例 'Stage.elements[].enemy'・'$talks.lines[].face'）。型で選ぶと入れ子の中・表の欄にも効く。
   * 並べると複数。重なったら 住所 → 部品.フィールド・$表.列 → 型 の順に、細かいものが使われる
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

/** 表のエディタの行の見せ方（部品の見せ方の表版）。行を選んだときの右の欄の上に、拡張の中身を足す */
export interface RowDrawer {
  /** 表の名前（例 'bullets'。$ は付けない） */
  table: string;
  /** 標準の欄を隠す: 'all' か、列の名前の並び */
  hide?: 'all' | string[];
  mount(el: HTMLElement, row: RowView, api: EditorApi): void | (() => void);
}

export interface RowView {
  readonly table: string;
  readonly id: string;
  /** 既定値で埋めた今の値 */
  readonly values: Record<string, unknown>;
  /** 変えられる */
  readonly editable: boolean;
  /** 🔒 その列がロックされている（set は効かない） */
  locked(column: string): boolean;
  /** この行の値を1つ変える（edits に書かなくても変えられる。行を足す・消すのは edits に $表.* を書いて api.patch） */
  set(column: string, value: unknown): void;
}

/** エディタ拡張。窓口（panel・fields・components・rows・menus）は要る分だけ書く */
export interface EditorExtension {
  /** 英数字・_・- （操作ログには window:<id> と残る） */
  id: string;
  /** パネルのタブの名前（パネルがあるとき） */
  title?: string;
  /** 何のための拡張か（1行。地図に出る。AI が同じものを作らないように） */
  desc?: string;
  /**
   * パネルが変える値の住所（地図に出る）。書いたら、それ以外は変えられない。欄・部品の見せ方は、その欄・部品なら書かなくても変えられる。
   * 例: 'main#spawner.Spawner.interval'、中をまとめて 'main#spawner.Spawner.*'、'@enemy.*'、'$enemies.*'。ロックされた値は変えられない。
   * '@[enemy]' はタグ enemy のプレハブすべて（作る・写す・名前・元・消すも。変える前と後の両方でタグを持つこと）、'@[enemy].Enemy.*' はその部品の値だけ
   */
  edits?: string[];
  /** 拡張の見た目（CSS の文字。エディタに1つの style として入る。クラスの名前は拡張の id から始めると、ほかとぶつからない） */
  css?: string;
  /** パネル（Unity の EditorWindow）。パネルの右上の ↗ で別のウインドウに開ける */
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
  /** 表のエディタの行の見せ方 */
  rows?: RowDrawer[];
  /** 右クリックのメニューの項目 */
  menus?: MenuItem[];
}

/** 右クリックのメニューの項目 */
export interface MenuItem {
  label: string;
  /** どこの右クリックに出すか。'entity': シーンの物（階層・ゲームの画面）。'prefab': 階層のプレハブ（targets は ['@名前']） */
  where: 'entity' | 'prefab';
  /** 出すかどうか（targets は選んでいる物の住所） */
  when?(targets: string[], api: EditorApi): boolean;
  run(targets: string[], api: EditorApi): void | Promise<void>;
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

/** 欄の見せ方の match の決まり（細かさ・当たるか）。サーバーの「変えてよい値か」と同じもの */
export { matchRank, matchField, fieldKey } from '../core/drawers.ts';
