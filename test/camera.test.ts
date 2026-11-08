// 段階2-2: カメラ（変換・画面の大きさへの合わせ方・追いかけ・範囲の制限・揺れ・複数のカメラ）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { camerasOf, defaultCamera, fitView, screenToWorld, visibleCorners, worldToScreen } from '../src/core/camera.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≒ ${b}`);

test('画面の大きさへの合わせ方: 全体を入れる・はみ出しを切る・伸ばす・周りも見せる・整数倍', () => {
  // 480x640 のゲームを 1000x700 の画面へ
  assert.deepEqual(fitView(480, 640, 1000, 700, 'contain'), { viewW: 480, viewH: 640, x: (1000 - 525) / 2, y: 0, w: 525, h: 700 });
  const cover = fitView(480, 640, 1000, 700, 'cover');
  near(cover.w, 1000); near(cover.h, 640 * (1000 / 480)); near(cover.y, (700 - cover.h) / 2);
  assert.deepEqual(fitView(480, 640, 1000, 700, 'stretch'), { viewW: 480, viewH: 640, x: 0, y: 0, w: 1000, h: 700 });
  const ex = fitView(480, 640, 1000, 700, 'expand');
  assert.deepEqual([ex.viewW, ex.viewH, ex.w, ex.h], [Math.round(1000 / (700 / 640)), 640, 1000, 700]);
  assert.deepEqual(fitView(480, 640, 1000, 700, 'pixel'), { viewW: 480, viewH: 640, x: 260, y: 30, w: 480, h: 640 });
});

test('座標の変換: 位置・拡大・回転・画面の中の範囲。行って戻ると元に戻る', () => {
  const c = { ...defaultCamera(800, 600), x: 100, y: 50, zoom: 2, rot: 90, vx: 400, vy: 0, vw: 400, vh: 300 };
  const [sx, sy] = worldToScreen(c, 110, 50);
  // 右に10 → 2倍で20、カメラが90度回っているので画面では上へ
  near(sx, 600); near(sy, 150 - 20);
  const [wx, wy] = screenToWorld(c, sx, sy);
  near(wx, 110); near(wy, 50);
  const q = visibleCorners({ ...defaultCamera(200, 100), x: 0, y: 0 });
  assert.deepEqual(q.map((v) => Math.round(v)), [-100, -50, 100, -50, 100, 50, -100, 50]);
});

test('カメラがなければ画面全体をそのまま映す。あれば描く順に並び、使わないものは外す', async () => {
  const p = await Project.load(await fresh());
  await p.apply([{ op: 'removeEntity', scene: 'main', id: 'camera' }], ai);
  const g0 = p.newGame();
  assert.deepEqual(camerasOf(g0.world, 480, 640).map((c) => [c.id, c.x, c.y, c.vw]), [[null, 240, 320, 480]]);
  await p.apply([
    { op: 'addEntity', scene: 'main', entity: { id: 'ui', components: { Transform: { x: 240, y: 320 }, Camera: { depth: 5, layerMin: 10 } } } },
    { op: 'addEntity', scene: 'main', entity: { id: 'map', components: { Transform: { x: 0, y: 0 }, Camera: { depth: 1, viewPos: [0.75, 0], viewSize: [0.25, 0.25], zoom: 0.25, clear: true } } } },
    { op: 'addEntity', scene: 'main', entity: { id: 'off', components: { Transform: {}, Camera: { enabled: false } } } },
  ], ai);
  const cams = camerasOf(p.newGame().world, 480, 640);
  assert.deepEqual(cams.map((c) => c.id), ['map', 'ui']);
  assert.deepEqual([cams[0].vx, cams[0].vw, cams[0].clear], [360, 120, '#000000']);
  assert.deepEqual([cams[1].layerMin, cams[1].layerMax], [10, 100]);
});

test('追いかける: 遅れ・ずらし・動かない範囲・見せる範囲の制限', async () => {
  const p = await Project.load(await fresh());
  await p.apply([{ op: 'set', path: 'main#camera.Camera.follow', value: 'player' }, { op: 'set', path: 'main#camera.Camera.offset', value: [0, -100] }], ai);
  let g = p.newGame();
  g.step();
  const pl = g.world.get('player')!.c.Transform, cam = g.world.get('camera')!.c.Transform;
  assert.deepEqual([cam.x, cam.y], [pl.x, pl.y - 100], 'lag 0 ならぴったり');
  await p.apply([{ op: 'set', path: 'main#camera.Camera.lag', value: 0.5 }], ai);
  g = p.newGame();
  g.step();
  const t = g.world.get('camera')!.c.Transform;
  near(t.y, 320 + (460 - 320) / 2); // 自機 y=560、ずらし -100 → 460 の半分まで
  // 動かない範囲: 相手が中心から 200 以内なら動かない
  await p.apply([{ op: 'set', path: 'main#camera.Camera.lag', value: 0 }, { op: 'set', path: 'main#camera.Camera.deadzone', value: [50, 200] }], ai);
  g = p.newGame();
  g.step();
  assert.deepEqual([g.world.get('camera')!.c.Transform.x, g.world.get('camera')!.c.Transform.y], [240, 320]);
  // 見せる範囲の制限: 2倍に拡大すると見える範囲は 240x320。ワールド 0..480 x 0..640 の外は見せない
  await p.apply([{ op: 'set', path: 'main#camera.Camera.deadzone', value: [0, 0] }, { op: 'set', path: 'main#camera.Camera.zoom', value: 2 }, { op: 'set', path: 'main#camera.Camera.limit', value: true },
    { op: 'set', path: 'main#camera.Camera.limitMax', value: [480, 640] }, { op: 'set', path: 'main#camera.Camera.offset', value: [0, 200] }], ai);
  g = p.newGame();
  g.step();
  assert.equal(g.world.get('camera')!.c.Transform.y, 640 - 160, '下の端で止まる');
});

test('揺れ: ctx.shake で強くなり、時間で収まる。ゲームの乱数を使わない', async () => {
  const p = await Project.load(await fresh());
  const g = p.newGame();
  g.step();
  g.ctx.shake(0.4);
  g.ctx.shake(0.8);
  const c = g.world.get('camera')!.c.Camera;
  assert.equal(c.trauma, 1, '強さは1まで');
  g.step();
  assert.ok(c.shakeX !== 0 || c.shakeY !== 0);
  assert.ok(Math.abs(c.shakeX) <= c.shakeMax && Math.abs(c.shakeY) <= c.shakeMax);
  for (let i = 0; i < 60; i++) g.step();
  assert.ok(c.trauma < 0.01 && c.shakeX === 0 && c.shakeY === 0, '1秒たらず（1.5/秒）で収まる');
  // 揺れはゲームの乱数を進めない（同じ回数だけ乱数を使った別の進め方と、次の乱数が一致する）
  const h = p.newGame();
  for (let i = 0; i < 62; i++) h.step();
  assert.equal(g.rng.next(), h.rng.next());
});

test('検証: 追いかける相手がいない・合わせ方の名前の間違いを知らせる', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await assert.rejects(p.apply([{ op: 'set', path: 'main#camera.Camera.follow', value: 'playr' }], ai), /playr.*そのIDはありません.*もしかして: player/);
  const file = join(dir, 'ages.project.json');
  const cfg = JSON.parse(await readFile(file, 'utf8'));
  cfg.view.fit = 'contian';
  await writeFile(file, JSON.stringify(cfg));
  const q = await Project.load(dir);
  assert.ok(q.validate().some((e) => /view\.fit="contian".*もしかして: contain/.test(e)));
});
