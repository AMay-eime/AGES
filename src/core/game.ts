// 固定更新のゲームループ。描画は知らない（ロジックだけ）。
import { World, type Entity } from './world.ts';
import { Rng } from './rng.ts';
import { Input } from './input.ts';
import type { Registry } from './registry.ts';
import type { SceneDoc, ProjectConfig } from './docs.ts';
import { DEFAULT_SOUND, isSoundPath, playCmd, type AudioCmd, type SoundApi, type SoundSettings } from './audio.ts';
import { suggest } from './schema.ts';

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

  constructor(registry: Registry, config: ProjectConfig, scene: SceneDoc, seed = config.seed) {
    this.registry = registry;
    this.config = config;
    this.world = new World(registry);
    this.rng = new Rng(seed);
    this.dt = 1 / config.fps;
    for (const e of scene.entities) this.world.add(e);
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

  private makeSoundApi(): SoundApi {
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
      stop: (name, fade) => this.sendAudio({ t: 'stop', frame: this.frame, ...(name ? { cue: name } : {}), ...(fade !== undefined ? { fade } : {}) }),
      stopMusic: (fade) => this.sendAudio({ t: 'stop', frame: this.frame, bus: 'bgm', ...(fade !== undefined ? { fade } : {}) }),
      playFrom: (id) => {
        const e = this.world.get(id);
        if (!e?.c.Sound) { this.warnings.add(`ctx.sound.playFrom("${id}"): その物に Sound がありません`); return false; }
        const s = { ...DEFAULT_SOUND, ...e.c.Sound } as SoundSettings;
        if (!s.clip) return false;
        this.sendAudio(playCmd(this.frame, e.prefab ?? e.id, s, {}, id));
        return true;
      },
      stopFrom: (id, fade) => this.sendAudio({ t: 'stop', frame: this.frame, owner: id, ...(fade !== undefined ? { fade } : {}) }),
      volume: (bus, value) => {
        const v = Math.max(0, Math.min(1, value));
        const mixer = this.world.query('Mixer')[0];
        if (mixer) mixer.c.Mixer[bus] = v;
        this.sendAudio({ t: 'volume', frame: this.frame, bus, value: v });
      },
    };
  }

  /** 1フレーム進める。keys はそのフレームで押されているキー。 */
  step(keys: Iterable<string> = []): void {
    this.input.setFrame(keys);
    if (!this.started) {
      this.started = true;
      for (const s of this.registry.systems) {
        if (!s.start) continue;
        try { s.start(this.ctx); } catch (err) { throw new GameError(s.name + '.start', this.frame, err); }
      }
      this.world.flush();
    }
    for (const s of this.registry.systems) {
      try { s.update(this.ctx); } catch (err) { throw new GameError(s.name, this.frame, err); }
    }
    this.world.flush();
    this.frame++;
  }

  /** 状態のハッシュ（同じ結果になったかの比較用） */
  hash(): string {
    const text = JSON.stringify([this.frame, this.rng.state, [...this.world.entities.values()].map((e) => [e.id, e.c])]);
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  snapshot() {
    return { frame: this.frame, rng: this.rng.state, world: this.world.snapshot(), counts: Object.fromEntries(this.counts) };
  }
}
