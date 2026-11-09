// 試しの舞台（拡張の api.stage）と画面なしの実行（api.run）の中身。DOM を使わない（Node のテストでも同じに動く）。
// ゲームの作り方は2つ: シーンを動かす（scene・params・values）か、空のシーンにプレハブを出す（spawn。ages run --spawn と同じ）。
// 入力は ages run --keys と同じ書き方。日時は決まった日時（RUN_DATE）なので、同じ指定なら毎回同じ結果になる。
import { Game, GameError, type GameEvent } from './game.ts';
import type { Registry } from './registry.ts';
import type { ProjectConfig, SceneDoc } from './docs.ts';
import { MemoryStore, type SaveStore } from './save.ts';
import { actionsFromRows } from './input.ts';
import { RunInput, parseRunKeys } from './runinput.ts';
import { RUN_DATE, parseDate } from './clock.ts';
import { suggest } from './schema.ts';
import { spawnTryout, tryoutGone, tryoutScene, type TryoutSpawn } from './tryout.ts';

/** 保存しない値の上書き: { 物のID: { 部品: { フィールド: 値 } } }（始めのシーンの物に。シーンに入り直すと元の値） */
export type ValueOverrides = Record<string, Record<string, Record<string, unknown>>>;

/** 何を動かすか（api.stage と api.run で同じ） */
export interface TrialSpec {
  /** 動かすシーン。省くと空のシーン（spawn だけ） */
  scene?: string;
  /** 始めのシーンに渡す ctx.scene.params */
  params?: Record<string, unknown>;
  /** シーンの物の値の上書き（保存しない） */
  values?: ValueOverrides;
  /** 出すプレハブ（x・y は画面の真ん中からのずれ。scene と一緒なら、そのシーンに出す） */
  spawn?: TryoutSpawn[];
  /** ctx.date の始め（'2026-12-25T09:00'。省くと決まった日時） */
  date?: string;
  seed?: number;
  /** 入力（ages run --keys と同じ書き方） */
  keys?: string;
}

export interface Trial {
  readonly game: Game;
  /** spawn で出した物の ID */
  readonly ids: string[];
  /** 1フレーム進める（keys の入力で） */
  step(): void;
  /** spawn で出した物がすべて消えたか（出していなければ false） */
  gone(): boolean;
}

/** シーンの写しに、値の上書きを重ねる（ない物・部品・フィールドは候補つきのエラー） */
export function withValues(registry: Registry, doc: SceneDoc, values: ValueOverrides): SceneDoc {
  const out: SceneDoc = { ...doc, entities: doc.entities.map((e) => ({ ...e, components: { ...e.components } })) };
  for (const [id, comps] of Object.entries(values)) {
    const e = out.entities.find((x) => x.id === id);
    if (!e) throw new Error(`values: 物 ${id} はシーン ${doc.name} にありません${suggest(id, doc.entities.map((x) => x.id))}`);
    for (const [comp, fields] of Object.entries(comps ?? {})) {
      const def = registry.components.get(comp);
      if (!def) throw new Error(`values: ${id}.${comp} という部品はありません${suggest(comp, [...registry.components.keys()])}`);
      for (const f of Object.keys(fields ?? {})) {
        if (!(f in def.fields)) throw new Error(`values: ${id}.${comp}.${f} というフィールドはありません${suggest(f, Object.keys(def.fields))}`);
      }
      e.components[comp] = { ...(e.components[comp] ?? {}), ...structuredClone(fields) };
    }
  }
  return out;
}

/**
 * ゲームを作る。opts.camera は空のシーンのときだけ（舞台の、画面の真ん中を映すカメラ。follow なら最初に出した物を追う）
 */
export function startTrial(registry: Registry, config: ProjectConfig, spec: TrialSpec, opts: { lang?: string; store?: SaveStore; camera?: { zoom: number; follow: boolean } } = {}): Trial {
  const v = config.view;
  const spawns = spec.spawn ?? [];
  let doc: SceneDoc;
  if (spec.scene !== undefined) {
    const d = registry.scenes.get(spec.scene);
    if (!d) throw new Error(`シーン ${spec.scene} はありません${suggest(spec.scene, [...registry.scenes.keys()].filter((n) => !n.startsWith('$')))}`);
    doc = spec.values ? withValues(registry, d, spec.values) : d;
  } else {
    if (!spawns.length) throw new Error('動かすものがありません（scene か spawn を書きます）');
    if (spec.values && Object.keys(spec.values).length) throw new Error('values はシーンの物の上書きです（scene と一緒に。出すプレハブの値は spawn の values に）');
    doc = tryoutScene();
    if (opts.camera) doc.entities.push({ id: 'tryout-camera', name: 'Camera', components: { Transform: { x: v.width / 2, y: v.height / 2 }, Camera: { zoom: opts.camera.zoom } } });
  }
  const actions = actionsFromRows(registry.tableView('actions').rows);
  const keys = parseRunKeys(spec.keys ?? '', actions);
  for (const k of keys.scene) if (!registry.scenes.has(k.scene)) throw new Error(`keys の ${k.scene}+${k.a}: シーン ${k.scene} はありません${suggest(k.scene, [...registry.scenes.keys()])}`);
  const game = new Game(registry, config, doc, spec.seed ?? config.seed, { store: opts.store ?? new MemoryStore({}), lang: opts.lang, params: spec.params, date: parseDate(spec.date || RUN_DATE) });
  const ids = spawns.length ? spawnTryout(game, spawns, v.width, v.height) : [];
  if (opts.camera?.follow && ids[0] && game.world.get('tryout-camera')) game.world.get('tryout-camera')!.c.Camera.follow = ids[0];
  const input = new RunInput(keys);
  return {
    game,
    ids,
    step() {
      const { input: inp, warning } = input.at(game, v.width, v.height);
      if (warning) game.warnings.add(`keys の click=${warning}: UI の付いた物 ${warning} がありません`);
      game.step(inp);
    },
    gone: () => tryoutGone(game, ids),
  };
}

/** 画面なしの実行の結果 */
export interface TrialResult {
  /** 進めたフレーム数 */
  frames: number;
  /** 止まった理由: frames（数だけ回した）・until・gone（spawn で出した物がすべて消えた）・aborted（signal）・error */
  stopped: 'frames' | 'until' | 'gone' | 'aborted' | 'error';
  /** かかった時間（ms。譲っていた時間も含む） */
  ms: number;
  events: Record<string, number>;
  sounds: Record<string, number>;
  particles: Record<string, number>;
  warnings: string[];
  /** 動かせなかった理由（ゲームのコードのエラーなど） */
  error?: string;
  /** 終わりの状態の hash（ages run と同じ） */
  hash: string;
  /** 終わりのゲーム（world・ctx を読める） */
  game: Game;
  /** spawn で出した物の ID */
  ids: string[];
}

export interface TrialRunOptions {
  /** 最大のフレーム数 */
  frames: number;
  /** true を返したら止める（フレームを進めるたびに） */
  until?(game: Game): boolean;
  /** フレームを進めるたびに（ids は spawn で出した物の ID） */
  onFrame?(game: Game, ids: string[]): void;
  /** 出来事が出るたびに（ctx.emit。中身の data も読める。フレームの途中で呼ぶ） */
  onEvent?(ev: GameEvent): void;
  signal?: AbortSignal;
  /** 続けて回す時間(ms。既定 12)。過ぎたら一度ほかの仕事（画面の更新・入力）に譲る */
  slice?: number;
}

/** ほかの仕事に一度譲る（setTimeout より待ちが短い） */
export function yieldTask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); r(); };
    ch.port2.postMessage(0);
  });
}

/** 少しずつ回す（画面を固めない）。エラーは投げずに結果の error に入れる */
export async function runTrial(trial: Trial, opts: TrialRunOptions): Promise<TrialResult> {
  const game = trial.game;
  const slice = opts.slice ?? 12;
  if (opts.onEvent) { const fn = opts.onEvent; game.listeners.push((ev) => fn(ev)); }
  const t0 = performance.now();
  let stopped: TrialResult['stopped'] | null = null;
  let error: string | undefined;
  while (!stopped) {
    const s = performance.now();
    // 譲るまでに、少なくとも1フレームは進める
    for (let n = 0; !stopped && (n === 0 || performance.now() - s < slice); n++) {
      if (opts.signal?.aborted) { stopped = 'aborted'; break; }
      if (game.frame >= opts.frames) { stopped = 'frames'; break; }
      try {
        trial.step();
      } catch (e) {
        error = e instanceof GameError ? e.message : `フレーム ${game.frame}: ${(e as Error).message}`;
        stopped = 'error';
        break;
      }
      try {
        opts.onFrame?.(game, trial.ids);
        if (trial.ids.length && trial.gone()) stopped = 'gone';
        else if (opts.until?.(game)) stopped = 'until';
      } catch (e) {
        error = `onFrame・until でエラー（フレーム ${game.frame}）: ${(e as Error).message}`;
        stopped = 'error';
      }
    }
    if (!stopped) await yieldTask();
  }
  return {
    frames: game.frame,
    stopped,
    ms: performance.now() - t0,
    events: Object.fromEntries(game.counts),
    sounds: Object.fromEntries(game.soundCounts),
    particles: Object.fromEntries(game.particleCounts),
    warnings: [...game.warnings],
    ...(error ? { error } : {}),
    hash: game.hash(),
    ids: [...trial.ids],
    game,
  };
}
