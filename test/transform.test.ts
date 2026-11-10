// 位置の親子（Transform.parent）: 親から見た値・画面の値・一緒に消える・親を変えても画面の位置はそのまま
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../src/core/registry.ts';
import { Game } from '../src/core/game.ts';
import type { ProjectConfig, SceneDoc } from '../src/core/docs.ts';
import { compose, relativeTo, deltaTo } from '../src/core/transform.ts';
import { camerasOf } from '../src/core/camera.ts';
import { docPose, nudgeOps } from '../src/editor/edit-ops.ts';

const CONFIG: ProjectConfig = { name: 't', fps: 60, seed: 1, view: { width: 400, height: 300, background: '#000' }, startScene: 'a', game: 'game/index.ts' };
type C = Record<string, Record<string, unknown>>;
const ent = (id: string, components: C) => ({ id, name: id, components });
function game(entities: ReturnType<typeof ent>[]) {
  const reg = Registry.from({ components: [], systems: [] });
  const scene: SceneDoc = { name: 'a', entities };
  reg.scenes.set('a', scene);
  return new Game(reg, CONFIG, scene);
}
const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} ≠ ${b}`);

test('位置の親子: 重ねる・戻すは逆。回転・倍率・鏡写し', () => {
  const p = { x: 100, y: 50, rot: 90, sx: 2, sy: 1 };
  const w = compose(p, { x: 10, y: 0, rot: 30, sx: 1, sy: 3 });
  // 親が90度回っているので、親の右(+x)は画面の下(+y)。倍率2で20
  near(w.x, 100); near(w.y, 70); near(w.rot, 120); near(w.sx, 2); near(w.sy, 3);
  const back = relativeTo(p, w);
  near(back.x, 10); near(back.y, 0); near(back.rot, 30); near(back.sx, 1); near(back.sy, 3);
  // 鏡写しの親: 子の x は逆向き、回転も逆向き
  const m = compose({ x: 0, y: 0, rot: 0, sx: -1, sy: 1 }, { x: 5, y: 2, rot: 10, sx: 1, sy: 1 });
  near(m.x, -5); near(m.y, 2); near(m.rot, -10);
  const r = relativeTo({ x: 0, y: 0, rot: 0, sx: -1, sy: 1 }, m);
  near(r.x, 5); near(r.rot, 10);
  const [dx, dy] = deltaTo({ x: 0, y: 0, rot: 90, sx: 1, sy: 1 }, 0, 10);
  near(dx, 10); near(dy, 0);
});

test('位置の親子: 親と一緒に動く・ctx.worldOf・当たり判定とカメラは画面の位置・親が消えると子も孫も消える', () => {
  const g = game([
    ent('boss', { Transform: { x: 100, y: 100 }, Collider: { shape: 'circle', r: 4 } }),
    ent('arm', { Transform: { x: 30, y: 0, parent: 'boss' }, Collider: { shape: 'circle', r: 4 } }),
    ent('gun', { Transform: { x: 10, y: 0, parent: 'arm' }, Collider: { shape: 'circle', r: 2 } }),
    ent('cam', { Transform: { x: 0, y: -20, parent: 'boss' }, Camera: {} }),
    ent('other', { Transform: { x: 0, y: 0 } }),
  ]);
  const ctx = g.ctx;
  assert.deepEqual(ctx.worldOf('gun'), { x: 140, y: 100, rot: 0, sx: 1, sy: 1 });
  // 親を回すと子は回りながら付いてくる
  g.world.get('boss')!.c.Transform.rot = 90;
  const gun = ctx.worldOf('gun')!;
  near(gun.x, 100); near(gun.y, 140); near(gun.rot, 90);
  assert.deepEqual(ctx.hit.point(100, 140), ['gun'], '当たり判定は画面の位置');
  assert.deepEqual(ctx.hit.point(140, 100), [], '親から見た位置では当たらない');
  const cam = camerasOf(g.world, 400, 300)[0];
  near(cam.x, 120); near(cam.y, 100); // (0,-20) を90度回すと (+20, 0)
  // 親のない物は Transform そのもの
  assert.equal(ctx.worldOf('other'), g.world.get('other')!.c.Transform);
  // 画面のこの位置に置く
  ctx.setWorldPos('gun', 100, 150);
  near(g.world.get('gun')!.c.Transform.x, 20); near(g.world.get('gun')!.c.Transform.y, 0);
  // 親が消えると子も孫も消える（フレームの終わり）
  ctx.destroy('boss');
  g.world.flush();
  assert.deepEqual([...g.world.entities.keys()], ['other']);
});

test('位置の親子: attach は画面の位置・向き・大きさを変えない。親の中の物は親にできない。輪になっていても止まる', () => {
  const g = game([
    ent('ship', { Transform: { x: 50, y: 50, rot: 90, sx: 2 } }),
    ent('opt', { Transform: { x: 70, y: 40, rot: 0 } }),
    ent('a', { Transform: { x: 1, parent: 'b' } }),
    ent('b', { Transform: { x: 1, parent: 'a' } }),
  ]);
  const before = { ...g.ctx.worldOf('opt')! };
  g.ctx.attach('opt', 'ship');
  const after = g.ctx.worldOf('opt')!;
  for (const k of ['x', 'y', 'rot', 'sx', 'sy'] as const) near(after[k], before[k], k);
  assert.equal(g.world.get('opt')!.c.Transform.parent, 'ship');
  assert.throws(() => g.ctx.attach('ship', 'opt'), /中にある/);
  g.ctx.attach('opt', null);
  near(g.world.get('opt')!.c.Transform.x, 70);
  assert.equal(g.world.get('opt')!.c.Transform.parent, null);
  assert.ok(Number.isFinite(g.ctx.worldOf('a')!.x), '輪でも止まる');
});

test('位置の親子（エディタ）: シーンのデータの画面の位置・矢印でずらすと親から見た値に直す・親も動かすなら子は動かさない', () => {
  const scene: SceneDoc = { name: 'a', entities: [
    ent('boss', { Transform: { x: 100, y: 100, rot: 90 } }),
    ent('arm', { Transform: { x: 30, parent: 'boss' } }),
  ] };
  const w = docPose(scene, 'arm')!;
  near(w.x, 100); near(w.y, 130);
  // 画面で右へ10 → 親は90度回っているので、親から見ると上(-y)へ10
  assert.deepEqual(nudgeOps(scene, ['arm'], 10, 0), [{ op: 'set', path: 'a#arm.Transform.x', value: 30 }, { op: 'set', path: 'a#arm.Transform.y', value: -10 }]);
  assert.deepEqual(nudgeOps(scene, ['boss', 'arm'], 10, 0).map((o) => (o as { path: string }).path), ['a#boss.Transform.x', 'a#boss.Transform.y']);
});
