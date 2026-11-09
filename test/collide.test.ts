// 段階2-12: 当たり判定の土台（円・矩形の重なりと、範囲・点・線での検索）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../src/core/registry.ts';
import { Game } from '../src/core/game.ts';
import type { ProjectConfig, SceneDoc } from '../src/core/docs.ts';
import { overlap, rayHit, shapeOf, type HitShape } from '../src/core/collide.ts';
import { Project } from '../src/project/project.ts';
import { cmdMap, cmdRun } from '../src/cli/ages.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };
const CONFIG: ProjectConfig = { name: 't', fps: 60, seed: 1, view: { width: 400, height: 300, background: '#000' }, startScene: 'a', game: 'game/index.ts' };
type C = Record<string, Record<string, unknown>>;
const ent = (id: string, components: C) => ({ id, name: id, components });
function game(entities: ReturnType<typeof ent>[]) {
  const reg = Registry.from({ components: [], systems: [] });
  const scene: SceneDoc = { name: 'a', entities };
  reg.scenes.set('a', scene);
  return new Game(reg, CONFIG, scene);
}
const box = (x: number, y: number, w: number, h: number, rot = 0, extra: Record<string, unknown> = {}) => ({ Transform: { x, y, rot }, Collider: { w, h, ...extra } });
const ball = (x: number, y: number, r: number, extra: Record<string, unknown> = {}) => ({ Transform: { x, y }, Collider: { shape: 'circle', r, ...extra } });

test('形の重なり: 円・矩形・回した矩形。触れているだけは重ならない。倍率・ずれも回る', () => {
  const g = game([
    ent('a', box(0, 0, 10, 10)), ent('touch', box(10, 0, 10, 10)), ent('b', box(9, 0, 10, 10)),
    ent('c1', ball(0, 20, 5)), ent('c2', ball(9.9, 20, 5)), ent('c3', ball(10, 20, 5)),
    // 45度回した正方形（対角の半分 ≈ 7.07）。角は (0,-7.07) まで届く
    ent('diamond', box(100, 0, 10, 10, 45)), ent('above', box(100, -11, 10, 10)), ent('above2', box(100, -13, 10, 10)),
    ent('corner', ball(107.5, 7.5, 2)),
    ent('scaled', { Transform: { x: 200, y: 0, rot: 90, sx: 2 }, Collider: { w: 10, h: 4, offset: [5, 0] } }),
  ]);
  const s = (id: string) => shapeOf(g.world.get(id)!)!;
  assert.ok(overlap(s('a'), s('b')));
  assert.ok(!overlap(s('a'), s('touch')), '辺が触れているだけ');
  assert.ok(overlap(s('c1'), s('c2')) && !overlap(s('c1'), s('c3')));
  assert.ok(overlap(s('diamond'), s('above')), '回した角が上の箱に届く');
  assert.ok(!overlap(s('diamond'), s('above2')));
  assert.ok(!overlap(s('diamond'), s('corner')), '外枠には入るが、回した形の外');
  // 倍率2で横20・ずれ10 → 90度回すと、中心は (200, 10)、縦20・横4
  const sc = s('scaled') as Extract<HitShape, { kind: 'rect' }>;
  assert.deepEqual([Math.round(sc.x), Math.round(sc.y), sc.hw, sc.hh], [200, 10, 10, 2]);
  assert.equal(rayHit(s('c1'), -20, 20, 20, 20), 0.375);
  assert.equal(rayHit(s('a'), 0, -20, 0, 20), 0.375);
  assert.equal(rayHit(s('a'), 20, -20, 20, 20), null);
});

test('ctx.hit: 重なっている相手・点・円・矩形・線。グループで絞る。消える物は数えない', () => {
  const g = game([
    ent('player', box(50, 50, 20, 20, 0, { group: 'player' })),
    ent('e1', box(60, 50, 10, 10, 0, { group: 'enemy' })),
    ent('coin', ball(45, 55, 4, { group: 'item' })),
    ent('e2', box(150, 50, 10, 10, 0, { group: 'enemy' })),
    ent('wall', box(100, 50, 4, 100, 0, { group: 'wall' })),
    ent('off', box(50, 50, 10, 10, 0, { group: 'enemy', enabled: false })),
  ]);
  const h = g.ctx.hit;
  assert.deepEqual(h.overlaps('player'), ['e1', 'coin'], 'ワールドに入った順。止めている物は数えない');
  assert.deepEqual(h.overlaps('player', 'enemy'), ['e1']);
  assert.deepEqual(h.overlaps('player', ['item', 'wall']), ['coin']);
  assert.deepEqual(h.point(45, 55), ['player', 'coin']);
  assert.deepEqual(h.circle(150, 50, 3), ['e2']);
  assert.deepEqual(h.rect(100, 0, 10, 10), ['wall']);
  assert.deepEqual(h.ray(0, 50, 200, 50, ['enemy', 'wall']), { id: 'e1', x: 55, y: 50, dist: 55 });
  assert.equal(h.ray(70, 50, 200, 50, 'enemy')!.id, 'e2', '線の始まりより後ろは数えない');
  assert.ok(h.test('player', 'e1') && !h.test('player', 'e2'));
  g.world.destroy('e1');
  assert.deepEqual(h.overlaps('player', 'enemy'), [], '消える物は数えない');
  assert.throws(() => h.overlaps('nope'), /物 nope はありません/);
  g.world.add({ id: 'bare', name: 'bare', components: { Transform: {} } });
  assert.throws(() => h.overlaps('bare'), /bare に Collider が付いていません/);
  h.overlaps('player', 'enemmy');
  assert.ok([...g.warnings].some((w) => /グループ "enemmy" の Collider がありません。もしかして: enemy/.test(w)));
});

test('重なり始め: with に書いたグループとだけ、1回。離れてまた重なればもう1回。結果は毎回同じ', () => {
  const run = () => {
    const g = game([
      ent('bullet', box(0, 0, 4, 4, 0, { group: 'bullet', with: ['enemy'] })),
      ent('enemy', box(30, 0, 10, 10, 0, { group: 'enemy' })),
      ent('friend', box(30, 0, 10, 10, 0, { group: 'friend' })),
    ]);
    const seen: string[] = [];
    for (const x of [0, 28, 30, 50, 30]) {
      g.world.get('bullet')!.c.Transform.x = x;
      g.step();
      seen.push(g.ctx.hit.entered('bullet').join(',') || '-');
    }
    return { seen, counts: [...g.hits.counts], hash: g.hash() };
  };
  const a = run();
  assert.deepEqual(a.seen, ['-', 'enemy', '-', '-', 'enemy']);
  assert.deepEqual(a.counts, [['bullet→enemy', 2]]);
  assert.equal(a.hash, run().hash);
});

test('サンプル: Collider と ctx.hit で当たりを処理し、ages run に hits:、地図にグループ。with の名前の間違いは検証で止まる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  const out = await cmdRun(dir, { frames: '1000', keys: '0-900:KeyZ;100-200:ArrowLeft;400-500:ArrowRight' });
  assert.match(out, /events: enemyKilled×1 playerHit×3 gameOver×1/);
  assert.match(out, /hits: .*bullet→enemy×\d+.*player→enemy×\d+/);
  assert.match(await cmdMap(dir), /当たり判定のグループ.*bullet→enemy {2}enemy {2}player→enemy/);
  const p = await Project.load(dir);
  await assert.rejects(p.apply([{ op: 'set', path: '@bullet.Collider.with', value: ['enemmy'] }], ai), /グループ "enemmy" の Collider がありません。もしかして: enemy/);
});
