// 追加パッケージ 3d のシステム（ゲームのシステムの後に動く）
import { defineCheck, defineSystem } from '../../core/registry.ts';
import { lookRotation, type Vec3 } from './math.ts';
import { worldPosition, type Pose3 } from './space.ts';

/** カメラが相手を追いかける（Camera3D.follow）。相手の位置 + offset へ、lag のぶん遅れて動き、look なら相手の方を向く */
export const camera3d = defineSystem({
  name: 'camera3d',
  desc: '3D のカメラが follow の相手を追いかける（3d）',
  reads: ['Camera3D'],
  writes: ['Transform3D'],
  update(ctx) {
    for (const e of ctx.world.entities.values()) {
      const c = e.c.Camera3D as { enabled: boolean; follow: string | null; offset: Vec3; lag: number; look: boolean; lookHeight: number } | undefined;
      const t = e.c.Transform3D as Pose3 | undefined;
      if (!c || !t || c.enabled === false || !c.follow) continue;
      const target = worldPosition(ctx.world, c.follow);
      if (!target) continue;
      const k = 1 - Math.max(0, Math.min(0.99, c.lag ?? 0));
      const o = c.offset ?? [0, 3, 6];
      t.x += (target[0] + o[0] - t.x) * k;
      t.y += (target[1] + o[1] - t.y) * k;
      t.z += (target[2] + o[2] - t.z) * k;
      if (c.look !== false) {
        const r = lookRotation([t.x, t.y, t.z], [target[0], target[1] + (c.lookHeight ?? 1), target[2]], true);
        t.rx = r.rx;
        t.ry = r.ry;
        t.rz = 0;
      }
    }
  },
});

export const SYSTEMS_3D = [camera3d];

/** 3D の部品は Transform3D と一緒に使う（なければ描かれない・照らさない） */
export const needsTransform3D = defineCheck({
  name: '3d-transform',
  desc: 'Mesh3D・Camera3D・Light3D の物には Transform3D が要る',
  run(view) {
    const out: string[] = [];
    const lacks = (c: Record<string, unknown>) => (['Mesh3D', 'Camera3D', 'Light3D'] as const).filter((k) => k in c && !('Transform3D' in c));
    for (const p of view.prefabs()) for (const k of lacks(p.components)) out.push(`@${p.name}: ${k} があるのに Transform3D がありません（位置が決まらず、使われません）`);
    for (const name of view.scenes) for (const e of view.scene(name)?.entities ?? []) for (const k of lacks(e.components ?? {})) out.push(`${name}#${e.id}: ${k} があるのに Transform3D がありません（位置が決まらず、使われません）`);
    return out;
  },
});

export const CHECKS_3D = [needsTransform3D];
