// 確認用のページ（ages export --review）で使うアセットを数える（issue #157）。
// 再生（--replay と同じ入力・区切りの params）と、見本帳に指定した物を Node で動かし、フレームごとに物の値・音の命令に出てくる
// アセットの場所を集める。書き出すのはそれだけ（足りないものを開こうとしたら、ページが知らせる）
import type { Game } from '../core/game.ts';
import type { Project } from './project.ts';
import { RunInput, type RunKeys } from '../core/runinput.ts';
import { MemoryStore } from '../core/save.ts';
import { spawnTryout, tryoutScene } from '../core/tryout.ts';
import { assetRefs } from '../core/assets.ts';
import type { DateStart } from '../core/clock.ts';

/** 値の中の、アセットの場所に当たる文字を集める */
function collect(v: unknown, assets: Set<string>, out: Set<string>, depth = 0): void {
  if (depth > 8 || v === null || v === undefined) return;
  if (typeof v === 'string') { if (assets.has(v)) out.add(v); return; }
  if (Array.isArray(v)) { for (const x of v) collect(x, assets, out, depth + 1); return; }
  if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) collect(x, assets, out, depth + 1);
}

export interface ReplaySpec {
  scene: string;
  seed: number;
  keys: RunKeys;
  save: Record<string, unknown>;
  date: DateStart;
  params?: Record<string, unknown>;
  lang?: string;
  frames: number;
}

/** 再生で使うアセットと、見本帳の物・音で使うアセット */
export function reviewAssets(p: Project, runs: ReplaySpec[], gallery: { prefabs: string[]; sounds: string[] }): Set<string> {
  const assets = new Set(p.assets.map((a) => a.path));
  const out = new Set<string>();
  collect(p.config, assets, out);
  const watch = (game: Game, frames: number, step: (g: Game) => void) => {
    game.audioListeners.push((cmd) => collect(cmd, assets, out));
    const scan = () => { for (const e of game.world.entities.values()) collect(e.c, assets, out); };
    scan();
    for (let i = 0; i < frames; i++) { step(game); scan(); }
  };
  for (const r of runs) {
    const game = p.newGame(r.scene, r.seed, new MemoryStore(structuredClone(r.save)), r.lang, undefined, r.params, r.date);
    const play = new RunInput(r.keys);
    const { width, height } = p.config.view;
    watch(game, r.frames, (g) => g.step(play.at(g, width, height).input));
  }
  // 見本帳: 空の場面に1つだけ出して、しばらく動かす（くり返しで出すものも拾う）。置いた値に書いてあるものも
  const refs = assetRefs(p.docs, p.registry);
  for (const name of gallery.prefabs) {
    for (const [a, at] of refs) if (at.some((x) => x === `@${name}` || x.startsWith(`@${name}.`) || x.startsWith(`@${name}/`))) out.add(a);
    const game = p.newGame(undefined, p.config.seed, new MemoryStore({}), undefined, tryoutScene());
    spawnTryout(game, [{ prefab: name }], p.config.view.width, p.config.view.height);
    watch(game, p.config.fps * 3, (g) => g.step());
  }
  for (const s of gallery.sounds) out.add(s);
  // モデルが外のファイルとして使っている画像
  for (const [model, textures] of p.registry.modelTextures) if (out.has(model)) for (const t of textures) out.add(t);
  return out;
}
