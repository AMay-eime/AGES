// 速さを文字で確かめる（ages run --perf）: システムごとの時間・重いフレームの ⚠・描いた量
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdInit, cmdPatch, cmdRun, perfLines } = await import('../src/cli/ages.ts');
const { Profile } = await import('../src/core/profile.ts');
const { findChrome } = await import('../src/cli/shot.ts');

test('計測の記録: 処理ごとの合計と最大・物の最大・いちばん長いフレーム・超えた数。測り直しは短い方を取る', () => {
  const make = (rows: [number, number, number][]) => {
    const p = new Profile();
    for (const [a, b, count] of rows) { p.add('a', a); if (b) p.add('b', b); p.end(a + b + 1, count); }
    return p;
  };
  // 3フレーム目だけ b が長い。2回目の計測では 1フレーム目の a がたまたま遅い
  const p = make([[2, 1, 5], [2, 0, 9], [2, 30, 7]]);
  assert.deepEqual(p.parts().map((x) => [x.name, x.ms, x.max, x.maxFrame]), [['b', 31, 30, 2], ['a', 6, 2, 0]]);
  assert.deepEqual(p.peak(), { frame: 2, count: 9 });
  assert.deepEqual(p.worst(), { frame: 2, ms: 33, parts: [['b', 30], ['a', 2]] });
  assert.deepEqual(p.summary(16), { total: 4 + 3 + 33, mean: 40 / 3, median: 4, over: 1, firstOver: 2 });
  p.merge(make([[50, 1, 5], [1, 0, 9], [2, 4, 7]]));
  assert.deepEqual(p.frames, [4, 2, 7]);
  assert.deepEqual(p.parts().map((x) => [x.name, x.ms]), [['a', 5], ['b', 5]]);
  assert.equal(p.summary(16).over, 0);

  // 行の形: 重い順・割合。1フレームの時間を超えると ⚠。描いた量が多いと ⚠
  const q = make([[1, 0.5, 3], [1, 0.5, 4], [1, 40, 4]]);
  const lines = perfLines(q, 60, 2, { draws: 12, quads: 340, particles: 0, layers: { '3d': { things: 20, shown: 15, draws: 5, tris: 612_000, particles: 80 } } });
  assert.match(lines[0], /^perf: 1フレーム 平均 16ms・真ん中 2\.5ms・最大 42ms @f2（60fps の1フレームは 17ms。物は最大 4 @f2）$/);
  assert.match(lines[1], /^  重い順: b 14ms 87%（最大 40 @f2）・a 1\.0ms 6%・ほか 1\.0ms$/);
  assert.match(lines[2], /^⚠ 1フレームの時間（17ms）を超えたフレームが 1（最初 f2。いちばん長い f2 は b 40ms・a 1\.0ms）$/);
  assert.equal(lines[3], '  描画 @f2（物がいちばん多いフレーム）: 命令 12回・2D の四角 340／3D: 物 20（画面内 15）・三角形 612,000・粒 80');
  assert.match(lines[4], /^⚠ 描く量が多い/);
});

async function project(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-perf-')), 'g');
  await cmdInit(dir, 'g');
  await writeFile(join(dir, 'game', 'index.ts'), `import { defineComponent, defineSystem, type GameModule } from 'ages';
const Heavy = defineComponent({ name: 'Heavy', desc: '重い計算', fields: { n: { type: 'int', default: 0 }, sum: { type: 'number', default: 0 } } });
const light = defineSystem({ name: 'light', desc: '数える', reads: [], writes: ['Heavy'], update(ctx) { for (const e of ctx.world.query('Heavy')) (e.c.Heavy as { n: number }).n++; } });
// 20フレーム目だけ、長い計算（決まった回数。結果は sum に入る）
const heavy = defineSystem({ name: 'heavy', desc: '20フレーム目に長い計算', reads: [], writes: ['Heavy'], update(ctx) {
  for (const e of ctx.world.query('Heavy')) {
    const h = e.c.Heavy as { n: number; sum: number };
    let s = 0;
    for (let i = 0; i < (ctx.frame === 20 ? 60_000_000 : 20_000); i++) s = (s + i * 7) % 1000003;
    h.sum = s;
  }
} });
export const components: GameModule['components'] = [Heavy];
export const systems: GameModule['systems'] = [light, heavy];
`);
  await cmdPatch(dir, [
    { op: 'addEntity', scene: 'main', entity: { id: 'calc', components: { Heavy: {} } } },
    ...[0, 1, 2].map((i) => ({ op: 'addEntity' as const, scene: 'main', entity: { id: `box${i}`, components: { Transform: { x: 40 + i * 30, y: 40 }, Shape: { kind: 'rect', w: 20, h: 20, color: '#ff0000' } } } })),
  ], false);
  return dir;
}

test('ages run --perf: 重いシステムが上に出て、1フレームの時間を超えたフレームを ⚠ で知らせる。付けても結果（hash）は同じ', async () => {
  const dir = await project();
  const plain = await cmdRun(dir, { frames: '40' });
  assert.doesNotMatch(plain, /perf:/);
  const out = await cmdRun(dir, { frames: '40', perf: 'logic' });
  assert.equal(/hash=(\w+)/.exec(out)![1], /hash=(\w+)/.exec(plain)![1]);
  assert.match(out, /^perf: 1フレーム 平均 [\d.]+ms・真ん中 [\d.]+ms・最大 [\d.]+ms @f20（60fps の1フレームは 17ms。物は最大 4 @f1）$/m);
  assert.match(out, /^  重い順: heavy [\d.]+ms \d+%（最大 [\d.]+ @f20）/m);
  assert.match(out, /^⚠ 1フレームの時間（17ms）を超えたフレームが 1（最初 f20。いちばん長い f20 は heavy [\d.]+ms/m);
  assert.doesNotMatch(out, /描画/);
});

test('ages run --perf: 物がいちばん多いフレームを描いた量が出る（画像は置かない）。--shot と一緒なら画像も', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = await project();
  let out = await cmdRun(dir, { frames: '10', perf: true });
  assert.match(out, /^  描画 @f1（物がいちばん多いフレーム）: 命令 \d+回・2D の四角 3$/m);
  assert.ok(!existsSync(join(dir, '.ages', 'shots')), '画像は置かない');
  out = await cmdRun(dir, { frames: '10', perf: true, shot: '5' });
  assert.match(out, /描画 @f1/);
  assert.match(out, /^shot f5: \.ages\/shots\/main-f5\.png/m);
  assert.ok(existsSync(join(dir, '.ages', 'shots', 'main-f5.png')) && !existsSync(join(dir, '.ages', 'shots', 'main-f1.png')));

  // 3D: 物・画面内・三角形（箱は 12 枚。影の地図に描く分も数えるので 24）
  const cfg = join(dir, 'ages.project.json');
  await writeFile(cfg, JSON.stringify({ ...JSON.parse(await readFile(cfg, 'utf8')), packages: ['3d'] }, null, 2) + '\n');
  await cmdPatch(dir, [
    { op: 'addEntity', scene: 'main', entity: { id: 'cube', components: { Transform3D: {}, Mesh3D: {} } } },
    { op: 'addEntity', scene: 'main', entity: { id: 'behind', components: { Transform3D: { z: 50 }, Mesh3D: {} } } },
    { op: 'addEntity', scene: 'main', entity: { id: 'cam', components: { Transform3D: { z: 6 }, Camera3D: {} } } },
  ], false);
  out = await cmdRun(dir, { frames: '3', perf: true });
  assert.match(out, /^  描画 @f1（物がいちばん多いフレーム）: 命令 \d+回・2D の四角 3／3D: 物 2（画面内 1）・三角形 24$/m);
});
