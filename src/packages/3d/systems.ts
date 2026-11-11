// 追加パッケージ 3d のシステム（ゲームのシステムの後に動く）
import { defineCheck, defineSystem } from '../../core/registry.ts';
import { lookRotation, type Vec3 } from './math.ts';
import { worldPosition, type Pose3 } from './space.ts';
import { overlap3, shapeOf, type Shape3 } from './collide.ts';

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

/**
 * モデルの動きの時刻を進める（Model3D.clip）。くり返しは長さで折り返し、くり返さない動きは最後で止まって done になる。
 * clip が変わったら、前の動きのその時の姿勢を覚えて、fade 秒で混ぜる
 */
export const model3d = defineSystem({
  name: 'model3d',
  desc: 'モデルの動き（Model3D.clip）の時刻を進める（3d）',
  writes: ['Model3D'],
  update(ctx) {
    for (const e of ctx.world.entities.values()) {
      const c = e.c.Model3D as { model: string; clip: string; speed: number; loop: boolean; fade: number; time: number; done: boolean; playing: string; prevClip: string; prevTime: number; fadeLeft: number } | undefined;
      if (!c) continue;
      if ((c.clip ?? '') !== (c.playing ?? '')) {
        // 始まり（前の動きがない）は、書いてある time から。切り替えは、前の動きを覚えて 0 秒から
        if (c.playing) { c.prevClip = c.playing; c.prevTime = c.time ?? 0; c.fadeLeft = c.fade ?? 0; c.time = 0; }
        c.playing = c.clip ?? '';
        c.done = false;
        continue;
      }
      if ((c.fadeLeft ?? 0) > 0) c.fadeLeft = Math.max(0, c.fadeLeft - ctx.dt);
      if (!c.clip) continue;
      const step = ctx.dt * (c.speed ?? 1);
      // 長さ（モデルの要約から。モデルがない・動きの名前が違うなら分からないので、進めるだけ）
      const len = ctx.world.registry.models.get(c.model)?.[c.clip];
      let t = (c.time ?? 0) + step;
      if (len !== undefined && len > 0) {
        if (c.loop !== false) { t = ((t % len) + len) % len; c.done = false; }
        else { c.done = step >= 0 ? t >= len : t <= 0; t = Math.max(0, Math.min(len, t)); }
      }
      c.time = t;
    }
  },
});

/**
 * 当たり判定の記録（Collider3D.with のある物）: いま重なっている相手（touching）と、このフレームに重なり始めた相手（entered）。
 * ゲームのシステムの後に動くので、ゲームのコードは次のフレームに読む（2D の ctx.hit.entered と同じ）
 */
export const collide3d = defineSystem({
  name: 'collide3d',
  desc: '3D の当たり判定の重なりを記録する（Collider3D.with → touching・entered）（3d）',
  writes: ['Collider3D'],
  update(ctx) {
    type C = { group: string; with: string[]; touching: string[]; entered: string[] };
    let all: { id: string; g: string; s: Shape3 }[] | null = null;
    for (const e of ctx.world.entities.values()) {
      const c = e.c.Collider3D as C | undefined;
      if (!c) continue;
      if (!c.with?.length) { if (c.touching?.length) c.touching = []; if (c.entered?.length) c.entered = []; continue; }
      // 形を求めるのは、記録する物が1つでもあるときだけ
      if (!all) {
        all = [];
        for (const o of ctx.world.entities.values()) { const s = o.c.Collider3D ? shapeOf(ctx.world, o) : null; if (s) all.push({ id: o.id, g: String((o.c.Collider3D as C).group ?? ''), s }); }
      }
      const me = all.find((x) => x.id === e.id);
      const now = me ? all.filter((o) => o.id !== e.id && c.with.includes(o.g) && overlap3(me.s, o.s)).map((o) => o.id) : [];
      const before = new Set(c.touching ?? []);
      c.entered = now.filter((id) => !before.has(id));
      c.touching = now;
    }
  },
});

export const SYSTEMS_3D = [camera3d, model3d, collide3d];

/** 3D の部品は Transform3D と一緒に使う（なければ描かれない・照らさない） */
export const needsTransform3D = defineCheck({
  name: '3d-transform',
  desc: 'Mesh3D・Model3D・Camera3D・Light3D・Collider3D の物には Transform3D が要る',
  run(view) {
    const out: string[] = [];
    const lacks = (c: Record<string, unknown>) => (['Mesh3D', 'Model3D', 'Camera3D', 'Light3D', 'Collider3D'] as const).filter((k) => k in c && !('Transform3D' in c));
    for (const p of view.prefabs()) for (const k of lacks(p.components)) out.push(`@${p.name}: ${k} があるのに Transform3D がありません（位置が決まらず、使われません）`);
    for (const name of view.scenes) for (const e of view.scene(name)?.entities ?? []) for (const k of lacks(e.components ?? {})) out.push(`${name}#${e.id}: ${k} があるのに Transform3D がありません（位置が決まらず、使われません）`);
    return out;
  },
});

/** Model3D.clip に書いた動きが、モデルの中にあるか（名前の間違いは、動かないだけで気づきにくい） */
export const clipExists = defineCheck({
  name: '3d-clip',
  desc: 'Model3D.clip の動きがモデルの中にある',
  run(view) {
    const out: string[] = [];
    const bad = (c: Record<string, unknown>): string | null => {
      const m = c.Model3D as { model?: string; clip?: string } | undefined;
      const clips = m?.clip && m.model ? view.asset?.(m.model)?.model?.clips : undefined;
      if (!m || !clips || clips.includes(m.clip!)) return null;
      return `Model3D.clip: ${m.model} に動き ${m.clip} がありません（${clips.length ? `あるのは ${clips.join(' ')}` : 'このモデルに動きはありません'}）`;
    };
    for (const p of view.prefabs()) { const b = bad(p.components); if (b) out.push(`@${p.name}.${b}`); }
    for (const name of view.scenes) for (const e of view.scene(name)?.entities ?? []) { const b = bad(e.components ?? {}); if (b) out.push(`${name}#${e.id}.${b}`); }
    return out;
  },
});

/** Collider3D.with に書いたグループを、どの物も名乗っていない（名前の間違いは、当たらないだけで気づきにくい） */
export const groupExists = defineCheck({
  name: '3d-group',
  desc: 'Collider3D.with のグループを名乗る Collider3D がある',
  run(view) {
    type C = { group?: string; with?: string[] };
    const all: { at: string; c: C }[] = [];
    for (const p of view.prefabs()) if (p.components.Collider3D) all.push({ at: `@${p.name}`, c: p.components.Collider3D as C });
    for (const name of view.scenes) for (const e of view.scene(name)?.entities ?? []) if (e.components?.Collider3D) all.push({ at: `${name}#${e.id}`, c: e.components.Collider3D as C });
    const groups = new Set(all.map((x) => x.c.group ?? '').filter(Boolean));
    const out: string[] = [];
    for (const x of all) for (const g of x.c.with ?? []) if (!groups.has(g)) out.push(`${x.at}.Collider3D.with: グループ ${g} の Collider3D がどこにもありません（${groups.size ? `あるのは ${[...groups].join(' ')}` : 'group を書いた物がまだありません'}）`);
    return out;
  },
});

export const CHECKS_3D = [needsTransform3D, clipExists, groupExists];
