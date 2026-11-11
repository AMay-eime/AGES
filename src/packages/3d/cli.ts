// 追加パッケージ 3d の命令（Node だけ。入れているプロジェクトで `ages space <dir>`・MCP の ages_space として使える）
import type { PackageCommand } from '../../core/packages.ts';
import { Project } from '../../project/project.ts';
import { parseRunKeys, RunInput, type RunKeys } from '../../core/runinput.ts';
import { suggest } from '../../core/schema.ts';
import { actionsOf } from '../../cli/ages.ts';
import { describeSpace, type ModelBounds } from './look.ts';

/** 空間を文字で確かめる: 物の位置・大きさ・上下の関係・カメラからの見え方・当たり判定のずれ */
async function cmdSpace(dir: string, f: Record<string, string | true>): Promise<string> {
  const p = await Project.load(dir);
  const scene = typeof f.scene === 'string' ? f.scene : p.config.startScene;
  if (!p.docs.scenes.has(scene)) throw new Error(`シーン ${scene} はありません${suggest(scene, [...p.docs.scenes.keys()])}`);
  // 省くと 1フレームだけ進める（カメラの追いかけ・位置の親が効いた後を見る）
  const frames = f.frames !== undefined ? Number(f.frames) : 1;
  if (!Number.isInteger(frames) || frames < 0) throw new Error('--frames は 0 以上の整数です（その数だけ進めてから確かめる。省くと 1）');
  const keys: RunKeys = typeof f.keys === 'string' ? parseRunKeys(f.keys, actionsOf(p)) : { events: [], clicks: [], scene: [] };
  const game = p.newGame(scene, f.seed !== undefined ? Number(f.seed) : p.config.seed);
  const play = new RunInput(keys);
  const { width, height } = p.config.view;
  for (let i = 0; i < frames; i++) game.step(play.at(game, width, height).input);
  const models: ModelBounds = new Map(p.assets.flatMap((a) => (a.model ? [[a.path, { size: a.model.size, center: a.model.center }] as const] : [])));
  const only = typeof f.only === 'string' ? f.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  for (const id of only ?? []) if (!game.world.entities.has(id)) throw new Error(`--only の ${id} はシーン ${scene} にありません${suggest(id, [...game.world.entities.keys()])}`);
  return [`space ${scene} f${game.frame}（単位 m・Y が上・画面 ${width}x${height}）`, ...describeSpace(game.world, { width, height, models, only })].join('\n');
}

export const COMMANDS: PackageCommand[] = [
  {
    name: 'space',
    desc: '3D の空間を文字で確かめる（物の位置・大きさ・何の上にあるか・浮き・沈み・画面のどこに映るか・隠れ・当たり判定のずれ）。置いた直後に',
    pos: 'scene',
    props: {
      scene: { type: 'string' },
      frames: { type: 'number', description: 'この数だけ進めてから（省くと 1）' },
      keys: { type: 'string', description: 'ages_run と同じ' },
      only: { type: 'string', description: 'この物だけ（例 "hero,coin1"）' },
    },
    run: cmdSpace,
  },
];
