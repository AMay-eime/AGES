// 固定更新のゲームループ。描画は知らない（ロジックだけ）。
import type { Pose } from './transform.ts';
import { World, type Entity } from './world.ts';
import { Rng } from './rng.ts';
import { Input, actionsFromRows, type FrameInput } from './input.ts';
import type { Registry } from './registry.ts';
import type { SceneDoc, ProjectConfig, PrefabDoc } from './docs.ts';
import { baseChain, resolveEntity } from './variant.ts';
import { DEFAULT_SOUND, isSoundPath, playCmd, type AudioCmd, type BusDef, type SoundApi, type SoundSettings } from './audio.ts';
import { suggest } from './schema.ts';
import type { RowOf, TableDef, TableView } from './table.ts';
import { camerasOf, screenToWorld } from './camera.ts';
import { checkEase, targetValue, tweenAt, type TweenOptions, type TweenState, type TweenValue } from './tween.ts';
import type { ParticleApi, ParticleCmd } from './particles.ts';
import { UiState } from './ui.ts';
import { SaveData, SETTINGS_KEY, type SaveApi, type SaveStore } from './save.ts';
import { format, languagesOf, lookup } from './i18n.ts';
import { HitState, contains, inGroup, overlap, rayHit, shapeOf, type HitShape } from './collide.ts';
import { dateAt, realDate, type DateStart, type GameDate } from './clock.ts';

export interface Ctx {
  world: World;
  input: Input;
  rng: Rng;
  /** 1フレームの秒数（固定） */
  dt: number;
  frame: number;
  /** 経過秒（frame * dt） */
  time: number;
  /**
   * 今の日時（遊ぶ人の時計の、始めた時刻＋ゲームの中で進んだ時間）。日付を使う遊び（日替わり・季節）に。
   * 画面なしの ages run では決まった日時（--date で変える）なので、毎回同じ結果になる
   */
  readonly date: GameDate;
  view: { width: number; height: number };
  spawn(prefab: string, overrides?: Record<string, Record<string, unknown>>): Entity;
  /** プレハブの中身を読む（派生は元と重ねた形、書いていない値は既定値。ないなら undefined）。読むだけ（凍らせてあり、書き換えるとエラー）。プレハブが変わるまで同じものを返すので、毎フレーム呼んでも軽い */
  prefab(name: string): { name: string; tags: string[]; components: Record<string, Record<string, any>> } | undefined;
  /** 消す（フレームの終わり）。位置の親（Transform.parent）がこの物の子も一緒に消える */
  destroy(id: string): void;
  /**
   * 画面（ワールド）の位置・向き・大きさ { x, y, rot, sx, sy }。位置の親（Transform.parent）がある物の Transform は親から見た値なので、
   * 画面の位置が要るとき（狙う・距離・当たり）はこれで読む。親がなければ Transform と同じ。Transform がなければ null
   */
  worldOf(e: Entity | string): Pose | null;
  /** 画面のこの位置に置く（親があれば親から見た位置に直して書く） */
  setWorldPos(e: Entity | string, x: number, y: number): void;
  /** 位置の親を変える（null で親なし）。画面の位置・向き・大きさはそのまま（例 ctx.attach(option, player)） */
  attach(child: Entity | string, parent: Entity | string | null): void;
  /** 出来事を出す（例: emit('enemyKilled', { id })）。defineSystem の on で受けたシステムが、その場で呼ばれる。ages run の要約に回数が載る */
  emit(event: string, data?: unknown): void;
  /** カメラを揺らす（強さ 0〜1 を足す。重ねると強くなる）。camera を省くと、使っているカメラすべて */
  shake(amount: number, camera?: string): void;
  /** 音を鳴らす・止める（例: ctx.sound.play('shot')）。画面なしの実行でも、何が何回鳴ったかが記録される */
  sound: SoundApi;
  /**
   * 表を読む。中身は変えられない。表の形（defineTable）を渡すと、行が型付きになる
   * 例: ctx.table(enemies).get('basic').hp　／　ctx.table('enemies').get('basic').hp
   */
  table<T extends TableDef>(def: T): TableView<RowOf<T>>;
  table(name: string): TableView;
  /**
   * マウス・タッチの位置を、ワールドの座標にする（カメラの位置・拡大・回転込み）。画面の外なら null
   * camera を省くと、その点を映している一番手前のカメラで
   */
  pointerWorld(camera?: string): [number, number] | null;
  /** シーン（今の名前・入ってからのフレーム・切り替え） */
  scene: SceneApi;
  /**
   * 値を時間で変える（トゥイーン）。to は { 'コンポーネント.フィールド': 行き先 }（'+10' のように書くと今からの差）。
   * how は表 $tweens の行の名前（手触りは人が表で決める）か、{ time, ease, delay, repeat, yoyo, destroy, emit, preset }。
   * 同じ物の同じ値のトゥイーンは、新しいものに置き換わる
   * 例: ctx.tween('player', { 'Sprite.tint': '#ff6060' }, 'hitFlash')
   */
  tween(target: string, to: Record<string, TweenValue>, how?: string | TweenOptions): void;
  /** トゥイーンを止める（値はそのまま）。field（'Sprite.alpha'）を省くと、その物のすべて */
  stopTween(target: string, field?: string): void;
  /** パーティクル（Particles の付いた物から粒を出す） */
  particles: ParticleApi;
  /** UI（画面に固定する物）の操作 */
  ui: UiApi;
  /** 当たり判定（Collider の重なり・範囲の検索）。group はグループの名前か、その並び（省くと全部） */
  hit: HitApi;
  /** セーブ（進み具合の保存・読み込み。設定は自動） */
  save: SaveApi;
  /** 今の言語の言葉（表 $text の行）。{名前} に params の値が入る。訳がなければ既定の言語 */
  t(key: string, params?: Record<string, unknown>): string;
  /** 今の言語（ages.project.json の languages のどれか） */
  readonly lang: string;
  /** 言語を変える（設定として自動で保存される。Text.key の文字もすぐ変わる） */
  setLang(lang: string): void;
  /** 使える言語（最初が既定） */
  readonly languages: readonly string[];
}

export interface HitApi {
  /** 今（呼んだ時点の位置で）重なっている相手。ワールドに入った順 */
  overlaps(id: string, group?: string | string[]): string[];
  /** 重なり始めた相手（Collider.with に書いたグループだけ。前のフレームの終わりの位置で。消えた物は除く） */
  entered(id: string, group?: string | string[]): string[];
  /** 2つが重なっているか */
  test(a: string, b: string): boolean;
  /** その点を含む物 */
  point(x: number, y: number, group?: string | string[]): string[];
  /** 円（中心と半径）に重なる物 */
  circle(x: number, y: number, r: number, group?: string | string[]): string[];
  /** 矩形（中心と幅・高さ）に重なる物 */
  rect(x: number, y: number, w: number, h: number, group?: string | string[]): string[];
  /** 線分で最初に当たる物（見通し・レーザーなど） */
  ray(x0: number, y0: number, x1: number, y1: number, group?: string | string[]): { id: string; x: number; y: number; dist: number } | null;
}

export interface UiApi {
  /** このフレームに押されたか（Button の付いた物。マウス・タッチで押して離したか、合わせて Enter・Pad.A） */
  clicked(id: string): boolean;
  /** このフレームに値が変わったか（drag の Gauge） */
  changed(id: string): boolean;
  /** このフレームに「戻る」（ui_cancel。なければ Esc・Pad.B）が押されたか */
  cancelled(): boolean;
  /** 矢印で合わせている物（null で外す） */
  focus(id: string | null): void;
  focused(): string | null;
  /** UI の四角（設計の大きさで数えた画面の座標。左上と幅・高さ） */
  rect(id: string): { x: number; y: number; w: number; h: number; visible: boolean } | null;
  /** マウス・タッチが UI の上にある（その押し下げはゲームに渡っていない） */
  pointerOver(): boolean;
}

export interface GotoOptions {
  /** 次のシーンに渡すもの（ctx.scene.params で読む） */
  params?: Record<string, unknown>;
  /** 消えていく・出てくるの秒数（片道）。0 ならすぐ切り替わる */
  fade?: number;
  /** 覆う色（既定 #000000） */
  color?: string;
  /** 残す物の ID（tag keep の付いた物は、書かなくても残る） */
  keep?: string[];
}

export interface Transition {
  /** out: 今のシーンが消えていく / in: 次のシーンが出てくる */
  phase: 'out' | 'in';
  /** 0〜1 */
  t: number;
  from: string;
  to: string;
  color: string;
}

export interface SceneApi {
  /** 今のシーンの名前 */
  readonly name: string;
  /** このシーンに入ってからのフレーム数（入った最初のフレームが 0） */
  readonly frame: number;
  /** goto で渡されたもの（最初のシーンは空） */
  readonly params: Readonly<Record<string, unknown>>;
  /** 切り替えの途中なら、その様子。途中でなければ null */
  readonly transition: Readonly<Transition> | null;
  /** シーンの名前の一覧 */
  readonly names: readonly string[];
  /**
   * 別のシーンへ切り替える（そのフレームの終わりに。fade があれば消えきってから）。
   * tag keep の付いた物と keep の ID の物は残り、次のシーンに同じ ID の物があれば、残した物のほうを使う
   */
  goto(name: string, opts?: GotoOptions): void;
  /** 今のシーンを最初からやり直す（goto と同じ。params は今のまま） */
  restart(opts?: GotoOptions): void;
}

export interface GameEvent {
  frame: number;
  name: string;
  data?: unknown;
}

export class GameError extends Error {
  system: string;
  frame: number;
  constructor(system: string, frame: number, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`フレーム ${frame} のシステム ${system} でエラー: ${msg}`);
    this.system = system;
    this.frame = frame;
    this.cause = cause;
  }
}

/** 音量の区分（AudioBus の付いたプレハブ）の一覧。overrides はゲームの中で変えた音量 */
export function busesOf(registry: Registry, overrides: Map<string, number> = new Map()): Record<string, BusDef> {
  const out: Record<string, BusDef> = {};
  for (const p of registry.allPrefabs()) {
    if (!p.components.AudioBus) continue;
    const b = registry.build('AudioBus', p.components.AudioBus) as unknown as BusDef;
    out[p.name] = { ...b, volume: overrides.get(p.name) ?? b.volume };
  }
  return out;
}

export class Game {
  readonly world: World;
  readonly input = new Input();
  readonly rng: Rng;
  readonly dt: number;
  readonly registry: Registry;
  readonly config: ProjectConfig;
  frame = 0;
  /** 出来事ごとの回数 */
  counts = new Map<string, number>();
  /** 直近の出来事（新しい順に最大200件） */
  recent: GameEvent[] = [];
  /** 出来事のリスナー */
  listeners: ((ev: GameEvent) => void)[] = [];
  /** 音の命令のリスナー（エディタやゲームの書き出しで、実際に鳴らす側） */
  audioListeners: ((cmd: AudioCmd) => void)[] = [];
  /** 鳴らした音ごとの回数（ages run の要約に載る） */
  soundCounts = new Map<string, number>();
  /** 進行中のトゥイーン */
  tweens: TweenState[] = [];
  /** パーティクルの命令のリスナー（描く側） */
  particleListeners: ((cmd: ParticleCmd) => void)[] = [];
  /** パーティクルを出した回数（物の名前・プレハブ → 回数。ages run の要約に載る） */
  particleCounts = new Map<string, number>();
  /** UI の操作（フォーカス・押している物）。フレームで数える */
  readonly ui = new UiState();
  /** セーブ（置き場所はブラウザなら localStorage、画面なしならメモリ） */
  readonly save: SaveData;
  private settingsDirty = false;
  /** 今の言語 */
  lang: string;
  readonly languages: string[];
  /** 当たり判定（重なり始めの記録） */
  readonly hits = new HitState();
  /** 押されたボタン（ID → 回数。ages run の要約用） */
  uiCounts = new Map<string, number>();
  /** 実行中に見つかった問題（同じものは1回だけ。ages run の要約に載る） */
  warnings = new Set<string>();
  private lastPlayed = new Map<string, number>();
  readonly ctx: Ctx;
  private started = false;
  /** 今のシーン */
  sceneName: string;
  sceneFrame = 0;
  sceneParams: Record<string, unknown> = {};
  /** 切り替えの途中（i: 進んだフレーム、n: 片道のフレーム） */
  private trans: { phase: 'out' | 'in'; i: number; n: number; from: string; to: string; color: string; params: Record<string, unknown>; keep: string[] } | null = null;
  /** シーンが切り替わったとき（from → to）。エディタはここで次のシーンの画像・音を読み込む */
  sceneListeners: ((from: string, to: string) => void)[] = [];
  /** これまでのシーンの移り変わり（ages run の要約に載る） */
  sceneLog: { frame: number; name: string }[] = [];

  /** 始めた日時（ctx.date はここから、ゲームの中の時間で進む） */
  readonly dateStart: DateStart;
  /** ゲームのコードが ctx.date を読んだか（ages run の要約に、使った日時を出す） */
  dateUsed = false;
  private dateCache: { frame: number; value: GameDate } | null = null;

  constructor(registry: Registry, config: ProjectConfig, scene: SceneDoc, seed = config.seed, opts: { store?: SaveStore; lang?: string; params?: Record<string, unknown>; date?: DateStart } = {}) {
    this.registry = registry;
    this.dateStart = opts.date ?? realDate();
    this.config = config;
    this.world = new World(registry);
    this.rng = new Rng(seed);
    this.dt = 1 / config.fps;
    this.sceneName = scene.name;
    this.sceneLog.push({ frame: 0, name: scene.name });
    // 始めのシーンに渡すもの（ages run --params。ふだんは前のシーンの goto が渡す）
    if (opts.params) this.sceneParams = { ...opts.params };
    if (!registry.scenes.has(scene.name)) registry.scenes.set(scene.name, scene);
    // プレハブのインスタンスは、プレハブと重ねた中身で置く（どのプレハブから来たかも覚える）
    for (const e of scene.entities) this.world.add(resolveEntity(registry.prefabs, e), e.prefab);
    // 操作の名前と割り当て（標準の表 $actions）
    if (registry.tables.has('actions')) {
      this.input.setActions(actionsFromRows(registry.tableView('actions').rows));
    }
    this.languages = languagesOf(config);
    registry.setLanguages(this.languages);
    this.lang = this.languages[0];
    this.save = new SaveData(opts.store);
    // 設定（キーの割り当て・音量）を戻し、変わったら自動で保存する
    if (config.save?.settings !== 'manual') {
      const st = this.save.read(SETTINGS_KEY) as { bindings?: Record<string, never>; volumes?: Record<string, number>; lang?: string } | undefined;
      if (st?.bindings) this.input.importBindings(st.bindings);
      if (st?.lang && this.languages.includes(st.lang)) this.lang = st.lang;
      for (const [bus, v] of Object.entries(st?.volumes ?? {})) if (typeof v === 'number') this.busVolumes.set(bus, Math.max(0, Math.min(1, v)));
      this.input.onBindings = () => { this.settingsDirty = true; };
    }
    // エディタ・ages run --lang で決めた言語（保存の設定より先）
    if (opts.lang && this.languages.includes(opts.lang)) this.lang = opts.lang;
    const game = this;
    this.ctx = {
      world: this.world,
      input: this.input,
      rng: this.rng,
      dt: this.dt,
      get frame() { return game.frame; },
      get time() { return game.frame * game.dt; },
      get date() {
        game.dateUsed = true;
        if (game.dateCache?.frame !== game.frame) game.dateCache = { frame: game.frame, value: Object.freeze(dateAt(game.dateStart, (game.frame * 1000) / game.config.fps)) };
        return game.dateCache.value;
      },
      view: { width: config.view.width, height: config.view.height },
      spawn: (p, o) => this.world.spawn(p, o),
      prefab: (name) => {
        // プレハブの中身（と派生の元）が変わるまでは作り置きを返す。変わると patch・エディタは中身を新しい物に差しかえるので、物が同じかで見分ける
        const map = this.registry.prefabs;
        const hit = this.prefabCache.get(name);
        if (hit && hit.map === map && hit.chain.every((d) => map.get(d.name) === d)) return hit.value;
        const doc = this.registry.findPrefab(name);
        if (!doc) return undefined;
        let chain: PrefabDoc[];
        try { chain = baseChain(map, name); } catch { chain = [map.get(name)!]; }
        const components: Record<string, Record<string, any>> = {};
        for (const [c, data] of Object.entries(doc.components)) {
          try { components[c] = this.registry.build(c, structuredClone(data)); } catch { components[c] = structuredClone(data); }
        }
        const value = deepFreeze({ name: doc.name, tags: [...(doc.tags ?? [])], components });
        this.prefabCache.set(name, { map, chain, value });
        return value;
      },
      destroy: (id) => this.world.destroy(id),
      worldOf: (e) => this.world.pose(e),
      setWorldPos: (e, x, y) => this.world.setWorldPos(e, x, y),
      attach: (c, p) => this.world.attach(c, p),
      shake: (amount, id) => {
        for (const e of this.world.query('Camera')) {
          if ((id && e.id !== id) || e.c.Camera.enabled === false) continue;
          e.c.Camera.trauma = Math.min(1, Math.max(0, (e.c.Camera.trauma ?? 0) + amount));
        }
      },
      sound: this.makeSoundApi(),
      tween: (target, to, how) => this.addTween(target, to, how),
      stopTween: (target, field) => {
        this.tweens = this.tweens.filter((t) => !(t.id === target && (!field || `${t.comp}.${t.field}${t.sub ? '.' + t.sub : ''}` === field)));
      },
      particles: {
        burst: (id, count) => {
          const e = this.world.get(id);
          if (!e?.c.Particles) { this.warnings.add(`ctx.particles.burst("${id}"): その物に Particles がありません`); return; }
          const n = Math.max(0, Math.floor(count ?? e.c.Particles.burst ?? 0));
          if (!n) return;
          const key = e.prefab ?? e.id;
          this.particleCounts.set(key, (this.particleCounts.get(key) ?? 0) + 1);
          const cmd: ParticleCmd = { t: 'burst', frame: this.frame, id, count: n };
          for (const l of this.particleListeners) l(cmd);
        },
        play: (id) => { const p = this.world.get(id)?.c.Particles; if (p) p.playing = true; else this.warnings.add(`ctx.particles.play("${id}"): その物に Particles がありません`); },
        stop: (id) => { const p = this.world.get(id)?.c.Particles; if (p) p.playing = false; else this.warnings.add(`ctx.particles.stop("${id}"): その物に Particles がありません`); },
      },
      table: ((def: string | TableDef) => this.registry.tableView(typeof def === 'string' ? def : def.name)) as Ctx['table'],
      pointerWorld: (camera) => {
        const p = this.input.pointer;
        // 画面の座標は設計の大きさ（ctx.view）で数える。どの画面でも同じ結果になる
        const cams = camerasOf(this.world, config.view.width, config.view.height);
        if (camera && !cams.some((c) => c.id === camera)) throw new Error(`pointerWorld: カメラ ${camera} がありません（Camera の付いた物のID）${suggest(camera, cams.flatMap((c) => (c.id ? [c.id] : [])))}`);
        if (!p) return null;
        const c = camera ? cams.find((x) => x.id === camera)! : [...cams].reverse().find((x) => p.x >= x.vx && p.y >= x.vy && p.x <= x.vx + x.vw && p.y <= x.vy + x.vh);
        return c ? screenToWorld(c, p.x, p.y) : null;
      },
      scene: this.makeSceneApi(),
      hit: this.makeHitApi(),
      save: this.save.api(this.world, this.registry, (m) => this.warnings.add(m)),
      t: (key, params) => this.translate(key, params),
      get lang() { return game.lang; },
      setLang: (lang) => {
        if (!this.languages.includes(lang)) throw new Error(`ctx.setLang: 言語 ${lang} はありません${suggest(lang, this.languages)}（ages.project.json の languages: ${this.languages.join(', ')}）`);
        if (lang === this.lang) return;
        this.lang = lang;
        this.settingsDirty = true;
        this.applyText();
      },
      languages: this.languages,
      ui: {
        clicked: (id) => this.ui.clicked.has(id),
        changed: (id) => this.ui.changed.has(id),
        cancelled: () => this.ui.cancelled,
        focus: (id) => {
          if (id !== null && !this.world.get(id)?.c.UI) throw new Error(`ctx.ui.focus: ${id} は UI の付いた物ではありません${suggest(id, [...this.world.entities.values()].filter((e) => e.c.UI).map((e) => e.id))}`);
          this.ui.focus = id;
        },
        focused: () => this.ui.focus,
        rect: (id) => { const r = this.ui.rects.get(id); return r ? { x: r.x, y: r.y, w: r.w, h: r.h, visible: r.visible } : null; },
        pointerOver: () => this.ui.over,
      },
      emit: (name, data) => {
        this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
        const ev: GameEvent = { frame: this.frame, name, data };
        this.recent.unshift(ev);
        if (this.recent.length > 200) this.recent.pop();
        for (const l of this.listeners) l(ev);
        this.dispatch(name, data);
      },
    };
    // Text.key の文字を、始めから今の言語に（エディタの止めている画面にも出る）
    this.applyText();
  }

  /** 今の言語の言葉。訳がなければ既定の言語で、⚠ で知らせる */
  private translate(key: string, params?: Record<string, unknown>): string {
    const view = this.registry.tables.has('text') ? this.registry.tableView('text') : null;
    const r = lookup(view, this.languages, this.lang, key);
    if (r.missing === 'key') this.warnings.add(`ctx.t: 表 $text に "${key}" の行がありません${suggest(key, [...(view?.ids ?? [])])}（行を足すか、名前を直す）`);
    else if (r.missing === 'lang') this.warnings.add(`ctx.t: $text.${key} に ${this.lang} の訳がありません（${this.languages[0]} で出しています）`);
    return format(r.text, params);
  }

  /** Text.key のある物に、今の言語の言葉を入れる */
  private applyText(): void {
    for (const e of this.world.entities.values()) {
      const tx = e.c.Text;
      if (tx?.key) tx.text = this.translate(tx.key);
    }
  }

  /** 変わった設定を保存する（フレームの終わりに自動で呼ぶ） */
  flushSettings(): void {
    if (!this.settingsDirty || this.config.save?.settings === 'manual') return;
    this.settingsDirty = false;
    this.save.write(SETTINGS_KEY, { bindings: this.input.exportBindings(), volumes: Object.fromEntries([...this.busVolumes].sort()), lang: this.lang });
  }

  private makeHitApi(): HitApi {
    const known = () => {
      const g = new Set(this.hits.groups);
      const add = (c?: Record<string, unknown>) => { if (c?.group) g.add(String(c.group)); };
      for (const p of this.registry.allPrefabs()) add(p.components.Collider);
      for (const s of this.registry.scenes.values()) for (const e of s.entities) add(e.components.Collider);
      for (const e of this.world.entities.values()) add(e.c.Collider);
      return g;
    };
    // 一度あると分かったグループの名前は調べ直さない（毎回すべてのプレハブ・物を見ると、弾の多いゲームで非常に遅くなる）
    const verified = new Set<string>();
    const checkGroup = (where: string, group?: string | string[]) => {
      if (group === undefined) return;
      const todo = (Array.isArray(group) ? group : [group]).filter((n) => !verified.has(n));
      if (!todo.length) return;
      const names = known();
      for (const n of todo) {
        if (names.has(n)) verified.add(n);
        else this.warnings.add(`ctx.hit.${where}: グループ "${n}" の Collider がありません${suggest(n, [...names])}（ある名前: ${[...names].join(', ') || 'なし'}）`);
      }
    };
    const find = (where: string, s: HitShape | null, group: string | string[] | undefined, skip?: string) => {
      checkGroup(where, group);
      if (!s) return [];
      const out: string[] = [];
      for (const e of this.world.entities.values()) {
        // 当たりのない物・違うグループを先に外す（形を作るのは候補だけ）
        if (!e.c.Collider || e.id === skip || !inGroup(e, group) || !this.world.isAlive(e.id)) continue;
        const o = shapeOf(e, this.world);
        if (o && overlap(s, o)) out.push(e.id);
      }
      return out;
    };
    const shapeById = (where: string, id: string) => {
      const e = this.world.get(id);
      if (!e) throw new Error(`ctx.hit.${where}: 物 ${id} はありません${suggest(id, [...this.world.entities.keys()].filter((k) => !k.includes('~')))}`);
      if (!e.c.Collider) throw new Error(`ctx.hit.${where}: ${id} に Collider が付いていません（当たり判定の形を付けてください）`);
      return shapeOf(e, this.world);
    };
    return {
      overlaps: (id, group) => find('overlaps', shapeById('overlaps', id), group, id),
      entered: (id, group) => {
        checkGroup('entered', group);
        return (this.hits.entered.get(id) ?? []).filter((o) => { const e = this.world.get(o); return e && this.world.isAlive(o) && inGroup(e, group); });
      },
      test: (a, b) => {
        const sa = shapeById('test', a), sb = shapeById('test', b);
        return !!sa && !!sb && this.world.isAlive(a) && this.world.isAlive(b) && overlap(sa, sb);
      },
      point: (x, y, group) => {
        checkGroup('point', group);
        return [...this.world.entities.values()].filter((e) => this.world.isAlive(e.id) && inGroup(e, group)).filter((e) => { const s = shapeOf(e, this.world); return s && contains(s, x, y); }).map((e) => e.id);
      },
      circle: (x, y, r, group) => find('circle', { kind: 'circle', x, y, r, box: { x0: x - r, y0: y - r, x1: x + r, y1: y + r } }, group),
      rect: (x, y, w, h, group) => find('rect', { kind: 'rect', x, y, hw: w / 2, hh: h / 2, cos: 1, sin: 0, box: { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 } }, group),
      ray: (x0, y0, x1, y1, group) => {
        checkGroup('ray', group);
        let best: { id: string; t: number } | null = null;
        for (const e of this.world.entities.values()) {
          if (!this.world.isAlive(e.id) || !inGroup(e, group)) continue;
          const s = shapeOf(e, this.world);
          const t = s ? rayHit(s, x0, y0, x1, y1) : null;
          if (t !== null && (!best || t < best.t)) best = { id: e.id, t };
        }
        if (!best) return null;
        const len = Math.hypot(x1 - x0, y1 - y0);
        const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
        return { id: best.id, x: r6(x0 + (x1 - x0) * best.t), y: r6(y0 + (y1 - y0) * best.t), dist: r6(len * best.t) };
      },
    };
  }

  /** 音の命令を出す（記録して、リスナーへ渡す） */
  sendAudio(cmd: AudioCmd): void {
    if (cmd.t === 'play') this.soundCounts.set(cmd.cue, (this.soundCounts.get(cmd.cue) ?? 0) + 1);
    for (const l of this.audioListeners) l(cmd);
  }

  /** プレハブ名かファイルの場所から、音の設定を求める */
  soundSettings(name: string): SoundSettings | null {
    const p = this.registry.findPrefab(name);
    if (p?.components.Sound) return this.registry.build('Sound', p.components.Sound) as unknown as SoundSettings;
    if (isSoundPath(name)) return { ...DEFAULT_SOUND, clip: name };
    const cues = this.registry.allPrefabs().filter((x) => x.components.Sound).map((x) => x.name);
    this.warnings.add(`音 "${name}" がありません（Sound の付いたプレハブの名前か、音のファイルの場所）${suggest(name, cues)}`);
    return null;
  }

  /** 音量の区分（AudioBus の付いたプレハブ）。鳴らす側に渡す */
  audioBuses(): Record<string, BusDef> {
    return busesOf(this.registry, this.busVolumes);
  }
  /** ゲームの中で変えた区分の音量（'' は全体） */
  private busVolumes = new Map<string, number>();
  /** ctx.prefab の作り置き（プレハブの表と、派生の元までの中身の物で見分ける） */
  private prefabCache = new Map<string, { map: Map<string, PrefabDoc>; chain: PrefabDoc[]; value: { name: string; tags: string[]; components: Record<string, Record<string, any>> } }>();

  private makeSoundApi(): SoundApi {
    const f = () => this.frame;
    return {
      play: (name, opts) => {
        const s = this.soundSettings(name);
        if (!s) return false;
        // 間引き: 前に鳴らしてから cooldown 秒たっていなければ鳴らさない（フレームで数えるので毎回同じ結果）
        const last = this.lastPlayed.get(name);
        if (s.cooldown > 0 && last !== undefined && (this.frame - last) * this.dt < s.cooldown - 1e-9) return false;
        this.lastPlayed.set(name, this.frame);
        this.sendAudio(playCmd(this.frame, name, s, opts));
        return true;
      },
      stop: (target, fade) => this.sendAudio({ t: 'stop', frame: f(), ...(target ? { target } : {}), ...(fade !== undefined ? { fade } : {}) }),
      stopBus: (bus, fade) => this.sendAudio({ t: 'stop', frame: f(), bus, ...(fade !== undefined ? { fade } : {}) }),
      fade: (target, volume, sec) => this.sendAudio({ t: 'fade', frame: f(), target, volume: Math.max(0, volume), sec: Math.max(0, sec) }),
      playFrom: (id) => {
        const e = this.world.get(id);
        if (!e?.c.Sound) { this.warnings.add(`ctx.sound.playFrom("${id}"): その物に Sound がありません`); return false; }
        const s = { ...DEFAULT_SOUND, ...e.c.Sound } as SoundSettings;
        if (!s.clip) return false;
        this.sendAudio(playCmd(this.frame, e.prefab ?? e.id, s, {}, id));
        return true;
      },
      volume: (bus, value) => {
        if (bus && !this.registry.findPrefab(bus)?.components.AudioBus) {
          const names = this.registry.allPrefabs().filter((p) => p.components.AudioBus).map((p) => p.name);
          this.warnings.add(`ctx.sound.volume: 音量の区分 "${bus}" がありません（AudioBus の付いたプレハブの名前。全体は ''）${suggest(bus, names)}`);
          return;
        }
        const v = Math.max(0, Math.min(1, value));
        this.busVolumes.set(bus, v);
        this.settingsDirty = true;
        this.sendAudio({ t: 'volume', frame: f(), bus, value: v });
      },
      getVolume: (bus) => this.busVolumes.get(bus) ?? (bus ? this.audioBuses()[bus]?.volume ?? 1 : 1),
    };
  }

  /** トゥイーンを足す（同じ物の同じ値のものは置き換える） */
  private addTween(target: string, to: Record<string, TweenValue>, how: string | TweenOptions = {}): void {
    const opts: TweenOptions = typeof how === 'string' ? { preset: how } : how;
    let base: { time: number; ease: string; delay: number; repeat: number; yoyo: boolean } = { time: 0.3, ease: 'outQuad', delay: 0, repeat: 0, yoyo: false };
    if (opts.preset) {
      const view = this.registry.tableView('tweens');
      if (!view.has(opts.preset)) throw new Error(`ctx.tween: 表 $tweens に ${opts.preset} はありません${suggest(opts.preset, [...view.ids])}（行を足すと、人が手触りを表で決められます）`);
      base = view.get(opts.preset) as unknown as typeof base;
    }
    const time = opts.time ?? base.time, delay = opts.delay ?? base.delay;
    const ease = checkEase(opts.ease ?? base.ease);
    const e = this.world.get(target);
    if (!e) throw new Error(`ctx.tween: 物 ${target} はありません${suggest(target, [...this.world.entities.keys()].filter((k) => !k.includes('~')))}`);
    const fps = this.config.fps;
    for (const [path, dest] of Object.entries(to)) {
      const [comp, field, sub, ...more] = path.split('.');
      const def = this.registry.components.get(comp);
      if (!def || !e.c[comp]) throw new Error(`ctx.tween: ${target} に ${comp} は付いていません${suggest(comp, Object.keys(e.c))}（行き先は 'コンポーネント.フィールド' で書きます）`);
      const top = def.fields[field];
      if (!top) throw new Error(`ctx.tween: ${comp} に ${field} はありません${suggest(String(field), Object.keys(def.fields))}`);
      // シェーダーの値は 'Effect.params.amount' のように中の名前まで書く
      let f = top;
      if (top.type === 'params') {
        const st = this.registry.shaderParams(e.c[comp][top.of]);
        if (!st) throw new Error(`ctx.tween: ${target} の ${comp}.${top.of} でシェーダーを選んでいません`);
        if (!sub || more.length) throw new Error(`ctx.tween: シェーダーの値は '${comp}.${field}.名前' で書きます（ある名前: ${Object.keys(st.fields).join(', ')}）`);
        if (!st.fields[sub]) throw new Error(`ctx.tween: ${comp}.${field} に ${sub} はありません${suggest(sub, Object.keys(st.fields))}（ある名前: ${Object.keys(st.fields).join(', ')}）`);
        f = st.fields[sub];
      } else if (sub !== undefined) throw new Error(`ctx.tween: 行き先は 'コンポーネント.フィールド' で書きます（受け取った値: ${path}）`);
      const holder = top.type === 'params' ? (e.c[comp][field] ??= {}) as Record<string, unknown> : e.c[comp];
      const key = top.type === 'params' ? sub : field;
      const at = `${target}.${path}`;
      const from = opts.from?.[path] !== undefined ? targetValue(at, f, holder[key], opts.from[path]) : structuredClone(holder[key] ?? (f as { default?: unknown }).default) as TweenValue;
      const value = targetValue(at, f, from, dest);
      this.tweens = this.tweens.filter((t) => !(t.id === target && t.comp === comp && t.field === field && t.sub === (top.type === 'params' ? sub : undefined)));
      this.tweens.push({
        id: target, comp, field, ...(top.type === 'params' ? { sub } : {}), from, to: value, start: this.frame + Math.round(delay * fps), frames: Math.max(1, Math.round(time * fps)),
        ease, repeat: Math.round(opts.repeat ?? base.repeat), yoyo: opts.yoyo ?? base.yoyo, cycle: 0, round: f.type === 'int',
        ...(opts.destroy ? { destroy: true } : {}), ...(opts.emit ? { emit: opts.emit } : {}),
      });
    }
  }

  /** トゥイーンを1フレーム進める（システムの後に） */
  private stepTweens(): void {
    if (!this.tweens.length) return;
    const keep: TweenState[] = [];
    for (const t of this.tweens) {
      const comp = this.world.isAlive(t.id) ? this.world.get(t.id)?.c[t.comp] : undefined;
      if (!comp) continue; // 物が消えたら、トゥイーンも終わり
      const c = t.sub ? ((comp[t.field] ??= {}) as Record<string, unknown>) : comp;
      const r = tweenAt(t, this.frame);
      if (r.value !== undefined) c[t.sub ?? t.field] = r.value;
      if (!r.done) { keep.push(t); continue; }
      if (t.emit) this.ctx.emit(t.emit, { id: t.id });
      if (t.destroy) this.world.destroy(t.id);
    }
    this.tweens = keep;
  }

  /** 出来事の中で出した出来事の深さ（受けた先でまた出す、を数える） */
  private depth = 0;
  /** 出来事を、受けるシステム（on）にその場で渡す */
  private dispatch(name: string, data: unknown): void {
    const subs = this.active().filter((s) => s.on && Object.hasOwn(s.on, name));
    if (!subs.length) return;
    if (this.depth >= 16) throw new Error(`出来事 ${name} の受け渡しが16段を超えました（on の中で出した出来事が、また同じ出来事を出していませんか）`);
    this.depth++;
    try {
      for (const s of subs) {
        try { s.on![name](this.ctx, data); } catch (err) { throw err instanceof GameError ? err : new GameError(`${s.name}.on.${name}`, this.frame, err); }
      }
    } finally { this.depth--; }
  }

  /** このシーンで動くシステム */
  private active() {
    return this.registry.systems.filter((s) => !s.scenes || s.scenes.includes(this.sceneName));
  }

  private makeSceneApi(): SceneApi {
    const game = this;
    const goto = (name: string, opts: GotoOptions = {}, keepParams = false) => {
      if (typeof name !== 'string' || !this.registry.scenes.has(name)) {
        throw new Error(`ctx.scene.goto: シーン ${name} はありません${suggest(String(name), [...this.registry.scenes.keys()])}`);
      }
      if (this.trans?.phase === 'out') return; // 切り替えの途中に重ねて呼んでも、最初のものだけ
      const n = Math.max(0, Math.round((opts.fade ?? 0) * this.config.fps));
      this.trans = { phase: 'out', i: 0, n, from: this.sceneName, to: name, color: opts.color ?? '#000000', params: keepParams ? this.sceneParams : { ...(opts.params ?? {}) }, keep: [...(opts.keep ?? [])] };
    };
    return {
      get name() { return game.sceneName; },
      get frame() { return game.sceneFrame; },
      get params() { return game.sceneParams; },
      get transition() { return game.transition; },
      get names() { return [...game.registry.scenes.keys()]; },
      goto: (name, opts) => goto(name, opts),
      restart: (opts) => goto(this.sceneName, opts, opts?.params === undefined),
    };
  }

  /** 切り替えの様子（描く側が画面を覆うのに使う） */
  get transition(): Transition | null {
    const t = this.trans;
    if (!t) return null;
    return { phase: t.phase, t: t.n ? Math.min(1, t.i / t.n) : 1, from: t.from, to: t.to, color: t.color };
  }

  /** 画面を覆う色と濃さ（0〜1）。覆っていなければ null */
  overlay(): { color: string; alpha: number } | null {
    const t = this.transition;
    if (!t) return null;
    const a = t.phase === 'out' ? t.t : 1 - t.t;
    return a > 0 ? { color: t.color, alpha: a } : null;
  }

  /** 今のシーンを出て、次のシーンに入る（フレームの終わりに） */
  private switchScene(): void {
    const t = this.trans!;
    for (const s of this.active()) {
      if (!s.exit) continue;
      try { s.exit(this.ctx); } catch (err) { throw err instanceof GameError ? err : new GameError(s.name + '.exit', this.frame, err); }
    }
    this.world.flush();
    const keep = new Set(t.keep);
    for (const e of this.world.entities.values()) if (!e.tags.includes('keep') && !keep.has(e.id)) this.world.destroy(e.id);
    this.world.flush();
    const doc = this.registry.scenes.get(t.to)!;
    for (const e of doc.entities) if (!this.world.entities.has(e.id)) this.world.add(resolveEntity(this.registry.prefabs, e), e.prefab);
    this.sceneName = t.to;
    this.sceneFrame = 0;
    this.sceneParams = t.params;
    this.started = false; // 次のフレームで、このシーンのシステムの start を呼ぶ
    this.trans = t.n ? { ...t, phase: 'in', i: 0 } : null;
    this.sceneLog.push({ frame: this.frame, name: t.to });
    this.ctx.emit('scene', { from: t.from, to: t.to });
    for (const l of this.sceneListeners) l(t.from, t.to);
  }

  /** 1フレーム進める。input はそのフレームの入力（押されているボタンの並びだけでもよい）。 */
  step(input: Iterable<string> | FrameInput = []): void {
    this.input.setFrame(input);
    // UI の操作はゲームのシステムより前に（押されたボタンを、そのフレームのうちに読めるように）
    this.ui.update(this.world, this.input, this.config.view.width, this.config.view.height);
    const systems = this.active();
    if (!this.started) {
      this.started = true;
      for (const s of systems) {
        if (!s.start) continue;
        try { s.start(this.ctx); } catch (err) { throw err instanceof GameError ? err : new GameError(s.name + '.start', this.frame, err); }
      }
      this.world.flush();
    }
    // ボタンの出来事は start の後に（受ける側の準備が済んでから）
    for (const id of this.ui.clicked) {
      this.uiCounts.set(id, (this.uiCounts.get(id) ?? 0) + 1);
      this.ctx.emit('ui.click', { id });
    }
    for (const s of systems) {
      if (!s.update) continue;
      try { s.update(this.ctx); } catch (err) { throw err instanceof GameError ? err : new GameError(s.name, this.frame, err); }
    }
    this.stepTweens();
    // 当たり判定: このフレームの終わりの位置で、重なり始めを求める（このフレームに消した物も数える。次のフレームで ctx.hit.entered に出る）
    this.hits.update(this.world);
    this.applyText(); // このフレームに出た物・変えた key も、描く前に言葉を入れる
    this.world.flush();
    this.flushSettings();
    this.frame++;
    this.sceneFrame++;
    const t = this.trans;
    if (t) {
      if (t.phase === 'out' && ++t.i >= t.n) this.switchScene();
      else if (t.phase === 'in' && ++t.i >= t.n) this.trans = null;
    }
  }

  /** 状態のハッシュ（同じ結果になったかの比較用） */
  hash(): string {
    const text = JSON.stringify([this.frame, this.rng.state, [...this.world.entities.values()].map((e) => [e.id, e.c]), this.sceneLog.length > 1 ? [this.sceneName, this.sceneFrame] : 0, this.tweens.length ? this.tweens : 0, this.ui.rects.size ? this.ui.snapshot() : 0, this.hits.snapshot().length ? this.hits.snapshot() : 0, this.save.keys().length ? this.save.all() : 0]);
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  snapshot() {
    return { frame: this.frame, rng: this.rng.state, world: this.world.snapshot(), counts: Object.fromEntries(this.counts), scene: { name: this.sceneName, frame: this.sceneFrame, params: this.sceneParams }, tweens: structuredClone(this.tweens), ui: this.ui.snapshot(), hits: this.hits.snapshot(), save: this.save.all() };
  }
}

/** 中まで凍らせる（ctx.prefab の作り置きを、ゲームのコードが書き換えられないように） */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}
