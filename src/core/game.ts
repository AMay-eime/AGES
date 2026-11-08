// 固定更新のゲームループ。描画は知らない（ロジックだけ）。
import { World, type Entity } from './world.ts';
import { Rng } from './rng.ts';
import { Input } from './input.ts';
import type { Registry } from './registry.ts';
import type { SceneDoc, ProjectConfig } from './docs.ts';

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
  /** 出来事のリスナー（エディタの効果音などに使う） */
  listeners: ((ev: GameEvent) => void)[] = [];
  private ctx: Ctx;
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
      emit: (name, data) => {
        this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
        const ev: GameEvent = { frame: this.frame, name, data };
        this.recent.unshift(ev);
        if (this.recent.length > 200) this.recent.pop();
        for (const l of this.listeners) l(ev);
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
