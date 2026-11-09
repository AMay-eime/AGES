// 決まったフレームの画面を撮る（ages run --shot）。CLI が headless の Chrome でこのページを開き、window.agesShot(設定) を呼ぶ。
// ages run と同じ入力（core/runinput.ts）で同じフレームまで進め、そのフレームの画面を PNG で返す。音は鳴らさない。
import { Registry, type GameModule } from '../core/registry.ts';
import { Game } from '../core/game.ts';
import { MemoryStore } from '../core/save.ts';
import { shaderMap } from '../core/shader.ts';
import { languagesOf } from '../core/i18n.ts';
import { spawnTryout, tryoutScene, type TryoutSpawn } from '../core/tryout.ts';
import { RunInput, type RunKeys } from '../core/runinput.ts';
import { parseDate } from '../core/clock.ts';
import { Renderer } from '../render/webgl.ts';
import type { EditorState } from './app.ts';

export interface ShotConfig {
  scene: string;
  seed: number;
  /** 撮るフレーム（そのフレームまで進めた後の画面。0 は最初のフレームを進める前） */
  frames: number[];
  /** 入力（--keys・--input をまとめたもの） */
  keys: RunKeys;
  /** 始めの日時（ctx.date。ages run と同じ） */
  date: string;
  params?: Record<string, unknown>;
  save?: Record<string, unknown>;
  lang?: string;
  spawns?: TryoutSpawn[];
  /** 画面の大きさの倍率（1 = view の大きさ） */
  scale?: number;
  /** 状態をまるごと返す（ages run と違うときに、どこが違うかを調べる） */
  dump?: boolean;
}

export interface ShotResult {
  shots: { frame: number; hash: string; png: string; snapshot?: unknown }[];
  /** 進めたフレーム */
  frame: number;
  error?: string;
}

async function shoot(cfg: ShotConfig): Promise<ShotResult> {
  const state = (await (await fetch('/api/state')).json()) as EditorState;
  if (state.error) throw new Error(state.error);
  const mod = (await import(`/project@${state.version}/${state.config.game}`)) as GameModule;
  const registry = Registry.from(mod);
  registry.prefabs = new Map(Object.entries(state.prefabs));
  registry.scenes = new Map(Object.entries(state.scenes));
  registry.sheets = new Map(Object.entries(state.sheets ?? {}));
  registry.tableData = new Map(Object.entries(state.tables ?? {}));
  registry.images = new Map(state.assets.filter((a) => a.w && a.h).map((a) => [a.path, { w: a.w!, h: a.h! }]));
  registry.shaders = shaderMap(state.assets.flatMap((a) => (a.shader ? [{ ...a.shader, path: a.path }] : [])));
  registry.setLanguages(languagesOf(state.config));
  const urlOf = (path: string) => {
    const f = state.files.find((x) => x.path === path);
    return `/project@${state.version}/${path.split('/').map(encodeURIComponent).join('/')}?m=${f?.mtime ?? 0}`;
  };

  const v = state.config.view;
  const scale = cfg.scale ?? 1;
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  canvas.width = Math.round(v.width * scale);
  canvas.height = Math.round(v.height * scale);
  const renderer = new Renderer(canvas, { urlOf, sheets: registry.sheets, filter: v.filter, shaders: registry.shaders });

  const store = new MemoryStore(cfg.save ?? {});
  const doc = cfg.spawns?.length ? tryoutScene() : state.scenes[cfg.scene];
  if (!doc) throw new Error(`シーン ${cfg.scene} はありません`);
  const game = new Game(registry, state.config, doc, cfg.seed, { store, lang: cfg.lang, params: cfg.spawns?.length ? undefined : cfg.params, date: parseDate(cfg.date) });
  if (cfg.spawns?.length) spawnTryout(game, cfg.spawns, v.width, v.height);
  game.particleListeners.push((cmd) => renderer.particles.burst(game.world, cmd.id, cmd.count));
  const play = new RunInput(cfg.keys);

  const draw = () => renderer.draw(game.world, { background: v.background, design: { width: canvas.width, height: canvas.height }, overlay: game.overlay(), particles: { dt: 0 }, post: true });
  const capture = async (): Promise<string> => {
    // 画像・フォントが読み込み終わるまで描き直す（描いて初めて読み込みが始まるものもある）
    for (let i = 0; i < 6; i++) {
      draw();
      await renderer.settled();
    }
    draw();
    return canvas.toDataURL('image/png').split(',')[1];
  };

  const targets = [...new Set(cfg.frames)].sort((a, b) => a - b);
  const shots: ShotResult['shots'] = [];
  const dt = 1 / state.config.fps;
  try {
    for (const t of targets) {
      while (game.frame < t) {
        const { input } = play.at(game, v.width, v.height);
        game.step(input);
        renderer.particles.update(game.world, dt);
      }
      const hash = game.hash();
      const snapshot = cfg.dump ? game.snapshot() : undefined;
      shots.push({ frame: game.frame, hash, png: await capture(), ...(snapshot ? { snapshot } : {}) });
    }
  } catch (e) {
    return { shots, frame: game.frame, error: (e as Error).message };
  }
  return { shots, frame: game.frame };
}

(window as unknown as { agesShot: typeof shoot }).agesShot = shoot;
