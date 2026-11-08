// 固定更新のゲームループ。描画は知らない（ロジックだけ）。
import { World, type Entity } from './world.ts';
import { Rng } from './rng.ts';
import { Input, actionsFromRows, type FrameInput } from './input.ts';
import type { Registry } from './registry.ts';
import type { SceneDoc, ProjectConfig } from './docs.ts';
import { DEFAULT_SOUND, isSoundPath, playCmd, type AudioCmd, type BusDef, type SoundApi, type SoundSettings } from './audio.ts';
import { suggest } from './schema.ts';
import type { RowOf, TableDef, TableView } from './table.ts';
import { camerasOf, screenToWorld } from './camera.ts';

export interface Ctx {
  world: World;
  input: Input;
  rng: Rng;
  /** 1フレームの秒数（固定） */
  dt: number;
  frame: number;
  /** 経過秒（frame * dt） */
  time: number;
  view: { width: number; height: number };
  spawn(prefab: string, overrides?: Record<string, Record<string, unknown>>): Entity;
  destroy(id: string): void;
  /** 出来事を記録する（例: emit('enemyKilled')）。ages run の要約に回数が載る */
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
  for (const p of registry.prefabs.values()) {
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

  constructor(registry: Registry, config: ProjectConfig, scene: SceneDoc, seed = config.seed) {
    this.registry = registry;
    this.config = config;
    this.world = new World(registry);
    this.rng = new Rng(seed);
    this.dt = 1 / config.fps;
    this.sceneName = scene.name;
    this.sceneLog.push({ frame: 0, name: scene.name });
    if (!registry.scenes.has(scene.name)) registry.scenes.set(scene.name, scene);
    for (const e of scene.entities) this.world.add(e);
    // 操作の名前と割り当て（標準の表 $actions）
    if (registry.tables.has('actions')) {
      this.input.setActions(actionsFromRows(registry.tableView('actions').rows));
    }
    const game = this;
    this.ctx = {
      world: this.world,
      input: this.input,
      rng: this.rng,
      dt: this.dt,
      get frame() { return game.frame; },
      get time() { return game.frame * game.dt; },
      view: { width: config.view.width, height: config.view.height },
      spawn: (p, o) => this.world.spawn(p, o),
      destroy: (id) => this.world.destroy(id),
      shake: (amount, id) => {
        for (const e of this.world.query('Camera')) {
          if ((id && e.id !== id) || e.c.Camera.enabled === false) continue;
          e.c.Camera.trauma = Math.min(1, Math.max(0, (e.c.Camera.trauma ?? 0) + amount));
        }
      },
      sound: this.makeSoundApi(),
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
      emit: (name, data) => {
        this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
        const ev: GameEvent = { frame: this.frame, name, data };
        this.recent.unshift(ev);
        if (this.recent.length > 200) this.recent.pop();
        for (const l of this.listeners) l(ev);
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
    const p = this.registry.prefabs.get(name);
    if (p?.components.Sound) return this.registry.build('Sound', p.components.Sound) as unknown as SoundSettings;
    if (isSoundPath(name)) return { ...DEFAULT_SOUND, clip: name };
    const cues = [...this.registry.prefabs.values()].filter((x) => x.components.Sound).map((x) => x.name);
    this.warnings.add(`音 "${name}" がありません（Sound の付いたプレハブの名前か、音のファイルの場所）${suggest(name, cues)}`);
    return null;
  }

  /** 音量の区分（AudioBus の付いたプレハブ）。鳴らす側に渡す */
  audioBuses(): Record<string, BusDef> {
    return busesOf(this.registry, this.busVolumes);
  }
  /** ゲームの中で変えた区分の音量（'' は全体） */
  private busVolumes = new Map<string, number>();

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
        if (bus && !this.registry.prefabs.get(bus)?.components.AudioBus) {
          const names = [...this.registry.prefabs.values()].filter((p) => p.components.AudioBus).map((p) => p.name);
          this.warnings.add(`ctx.sound.volume: 音量の区分 "${bus}" がありません（AudioBus の付いたプレハブの名前。全体は ''）${suggest(bus, names)}`);
          return;
        }
        const v = Math.max(0, Math.min(1, value));
        this.busVolumes.set(bus, v);
        this.sendAudio({ t: 'volume', frame: f(), bus, value: v });
      },
      getVolume: (bus) => this.busVolumes.get(bus) ?? (bus ? this.audioBuses()[bus]?.volume ?? 1 : 1),
    };
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
      try { s.exit(this.ctx); } catch (err) { throw new GameError(s.name + '.exit', this.frame, err); }
    }
    this.world.flush();
    const keep = new Set(t.keep);
    for (const e of this.world.entities.values()) if (!e.tags.includes('keep') && !keep.has(e.id)) this.world.destroy(e.id);
    this.world.flush();
    const doc = this.registry.scenes.get(t.to)!;
    for (const e of doc.entities) if (!this.world.entities.has(e.id)) this.world.add(e);
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
    const systems = this.active();
    if (!this.started) {
      this.started = true;
      for (const s of systems) {
        if (!s.start) continue;
        try { s.start(this.ctx); } catch (err) { throw new GameError(s.name + '.start', this.frame, err); }
      }
      this.world.flush();
    }
    for (const s of systems) {
      try { s.update(this.ctx); } catch (err) { throw new GameError(s.name, this.frame, err); }
    }
    this.world.flush();
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
    const text = JSON.stringify([this.frame, this.rng.state, [...this.world.entities.values()].map((e) => [e.id, e.c]), this.sceneLog.length > 1 ? [this.sceneName, this.sceneFrame] : 0]);
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  snapshot() {
    return { frame: this.frame, rng: this.rng.state, world: this.world.snapshot(), counts: Object.fromEntries(this.counts), scene: { name: this.sceneName, frame: this.sceneFrame, params: this.sceneParams } };
  }
}
