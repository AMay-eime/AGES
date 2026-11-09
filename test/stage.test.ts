// 試しの舞台（api.stage）と画面なしの実行（api.run）の、DOM のいらない中身:
// ゲームの作り方（シーン・params・値の上書き・spawn）、少しずつ回す、時間の操作（シーク・コマ送り・作り直して同じフレームへ・くり返し）、視点と描き込み
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { cmdRun } from '../src/cli/ages.ts';
import { runTrial, startTrial, yieldTask, type TrialSpec } from '../src/core/trial.ts';
import { StagePlayer, GAP, type PlayerSettings } from '../src/editor/stage-player.ts';
import { canvasToWorld, drawColliders, fitBox, freeView, makeDraw, visibleRect } from '../src/editor/stage-draw.ts';
import { worldToScreen } from '../src/core/camera.ts';
import type { SystemDef } from '../src/core/registry.ts';
import type { StageSummary } from '../src/editor/window-api.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

/** 決まったフレームで投げるシステム（エラーの扱いを確かめる） */
const boom = (frame: number): SystemDef => ({ name: 'boom', desc: 'テスト用', update(ctx) { if (ctx.frame === frame) throw new Error('ばーん'); } });

test('api.run の中身: シーンを入力つきで動かすと ages run と同じ結果。params・値の上書き（保存しない）', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  const r = await runTrial(startTrial(p.registry, p.config, { scene: 'main', keys: '0-600:@fire;100-200:ArrowLeft' }), { frames: 600 });
  assert.equal(r.stopped, 'frames');
  assert.equal(r.frames, 600);
  const cli = await cmdRun(dir, { frames: '600', keys: '0-600:@fire;100-200:ArrowLeft' });
  assert.match(cli, new RegExp(`hash=${r.hash}`), '同じ入力なら ages run と同じ状態');
  assert.ok(r.events.enemyKilled > 0 && r.sounds.se_shot > 0);

  // 値の上書き: シーンの物の値だけを変える（シーンの中身は変わらない）
  const base = p.docs.scenes.get('main')!.entities.find((e) => e.id === 'spawner')!.components.Spawner.interval;
  const t = startTrial(p.registry, p.config, { scene: 'main', values: { spawner: { Spawner: { interval: 5 } }, player: { Player: { speed: 9 } } } });
  assert.equal(t.game.world.get('spawner')!.c.Spawner.interval, 5);
  assert.equal(t.game.world.get('player')!.c.Player.speed, 9);
  assert.equal(p.docs.scenes.get('main')!.entities.find((e) => e.id === 'spawner')!.components.Spawner.interval, base, '保存しない');
  const enemies = (spec: TrialSpec) => { const x = startTrial(p.registry, p.config, spec); for (let i = 0; i < 120; i++) x.step(); return x.game.world.query('Enemy').length; };
  assert.ok(enemies({ scene: 'main', values: { spawner: { Spawner: { interval: 5 } } } }) > enemies({ scene: 'main' }), '上書きした値で動く');
  // params・日時
  const g = startTrial(p.registry, p.config, { scene: 'main', params: { stage: 2 }, date: '2026-12-25T09:00' }).game;
  assert.deepEqual(g.ctx.scene.params, { stage: 2 });
  assert.equal(g.ctx.date.month, 12);
  // 誤りには候補
  assert.throws(() => startTrial(p.registry, p.config, { scene: 'mian' }), /シーン mian はありません。もしかして: main/);
  assert.throws(() => startTrial(p.registry, p.config, { scene: 'main', values: { spawnr: { Spawner: { interval: 5 } } } }), /物 spawnr はシーン main にありません。もしかして: spawner/);
  assert.throws(() => startTrial(p.registry, p.config, { scene: 'main', values: { spawner: { Spawnr: { interval: 5 } } } }), /spawner\.Spawnr という部品はありません。もしかして: Spawner/);
  assert.throws(() => startTrial(p.registry, p.config, { scene: 'main', values: { spawner: { Spawner: { intervl: 5 } } } }), /Spawner\.intervl というフィールドはありません。もしかして: interval/);
  assert.throws(() => startTrial(p.registry, p.config, {}), /scene か spawn を書きます/);
  assert.throws(() => startTrial(p.registry, p.config, { spawn: [{ prefab: 'enemy' }], values: { player: {} } }), /values はシーンの物の上書きです/);
});

test('api.run の中身: until・onFrame・やめる・spawn が消えたら止まる・ゲームのエラーは結果に。少しずつ回す', async () => {
  const p = await Project.load(await fresh());
  let seen = 0;
  const u = await runTrial(startTrial(p.registry, p.config, { scene: 'main' }), { frames: 600, onFrame: () => { seen++; }, until: (g) => g.frame >= 100 });
  assert.equal(u.stopped, 'until');
  assert.equal(u.frames, 100);
  assert.equal(seen, 100);
  // spawn だけ（ages run --spawn と同じ。出した物がすべて消えたら止まる）
  const gone = await runTrial(startTrial(p.registry, p.config, { spawn: [{ prefab: 'explosion' }] }), { frames: 300 });
  assert.equal(gone.stopped, 'gone');
  assert.equal(gone.frames, 20);
  assert.deepEqual(gone.particles, { explosion: 1 });
  // シーンに出すこともできる
  const both = startTrial(p.registry, p.config, { scene: 'main', spawn: [{ prefab: 'enemy', x: 0, y: -200 }] });
  assert.ok(both.game.world.get('player') && both.ids.length === 1 && both.game.world.get(both.ids[0]));
  // 譲りながら回すので、途中でやめられる
  const ac = new AbortController();
  const long = runTrial(startTrial(p.registry, p.config, { scene: 'main' }), { frames: 1_000_000, signal: ac.signal, slice: 1 });
  await yieldTask();
  await yieldTask();
  ac.abort();
  const a = await long;
  assert.equal(a.stopped, 'aborted');
  assert.ok(a.frames > 0 && a.frames < 1_000_000);
  // ゲームのコードのエラーは投げずに結果へ
  p.registry.systems.push(boom(10));
  try {
    const e = await runTrial(startTrial(p.registry, p.config, { scene: 'main' }), { frames: 600 });
    assert.equal(e.stopped, 'error');
    assert.match(e.error!, /フレーム 10 のシステム boom でエラー: ばーん/);
  } finally {
    p.registry.systems.pop();
  }
});

test('舞台の時間の操作: シーク（前へは作り直す）・コマ送り・作り直して同じフレームへ・少しずつ進める', async () => {
  const p = await Project.load(await fresh());
  let spec: TrialSpec = { scene: 'main', keys: '0-9999:@fire' };
  const set: PlayerSettings = { fps: 60, limit: Infinity, loop: true, speed: 1 };
  const pl = new StagePlayer(() => startTrial(p.registry, p.config, spec), () => set);
  pl.build();
  const ref = async (frames: number) => (await runTrial(startTrial(p.registry, p.config, spec), { frames })).hash;

  let reached = false;
  const s = pl.seek(2).then(() => { reached = true; });
  assert.equal(pl.target, 120);
  pl.fastForward(Infinity);
  await s;
  assert.ok(reached);
  assert.equal(pl.game!.frame, 120);
  assert.equal(pl.game!.hash(), await ref(120), 'シークした状態は、そこまで回したものと同じ');
  // 前へは作り直す
  const first = pl.game;
  const back = pl.seek(1);
  assert.notEqual(pl.game, first);
  pl.fastForward(Infinity);
  await back;
  assert.equal(pl.game!.frame, 60);
  // コマ送りは一時停止して進める
  pl.step(3);
  assert.equal(pl.playing, false);
  assert.equal(pl.game!.frame, 63);
  // 作り直して同じフレームへ（値が変わったとき）。同じ値なら同じ状態
  const h63 = pl.game!.hash();
  pl.rebuildKeep();
  assert.equal(pl.game!.frame, 0);
  pl.fastForward(Infinity);
  assert.equal(pl.game!.frame, 63);
  assert.equal(pl.game!.hash(), h63);
  spec = { ...spec, values: { player: { Player: { speed: 9 } } } };
  pl.rebuildKeep();
  pl.fastForward(Infinity);
  assert.equal(pl.game!.frame, 63);
  assert.equal(pl.game!.world.get('player')!.c.Player.speed, 9);
  assert.equal(pl.playing, false, '一時停止のまま');
  // 少しずつ進める（1回の時間を短くすると、何回かに分かれる）
  void pl.seek(30);
  let calls = 0;
  while (pl.target !== null) { pl.fastForward(0); calls++; }
  assert.equal(pl.game!.frame, 1800);
  assert.ok(calls > 1, `1回で進めない（${calls}回）`);
  // 次のシークで前のシークは解決する
  const a = pl.seek(100);
  const b = pl.seek(40);
  await a;
  pl.fastForward(Infinity);
  await b;
  assert.equal(pl.game!.frame, 2400);
});

test('舞台の時間の操作: 実時間で進める・回の終わり（くり返す／止まる）・エラー', async () => {
  const p = await Project.load(await fresh());
  const cycles: StageSummary[] = [];
  const set: PlayerSettings = { fps: 60, limit: 30, loop: false, speed: 1, onCycle: (s) => cycles.push(s) };
  const pl = new StagePlayer(() => startTrial(p.registry, p.config, { scene: 'main' }), () => set);
  pl.build();
  pl.tick(1 / 60);
  assert.equal(pl.game!.frame, 1);
  pl.tick(0.1);
  assert.equal(pl.game!.frame, 7);
  set.speed = 2;
  pl.tick(0.1);
  assert.equal(pl.game!.frame, 19);
  pl.tick(0.25);
  assert.equal(pl.game!.frame, 30, '1回の長さで止まる');
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].frames, 30);
  assert.equal(pl.playing, false, 'くり返さないなら、終わりで止まる');
  pl.playing = true;
  assert.equal(pl.game!.frame, 0, '終わりから動かすと最初から');
  // くり返すなら、間をおいて最初から
  set.loop = true;
  set.speed = 1;
  for (let i = 0; i < 40 && !pl.done; i++) pl.tick(1 / 60);
  assert.ok(pl.done);
  const at = pl.done!.at;
  pl.tick(1 / 60, at + 10);
  assert.equal(pl.game!.frame, 30, 'すぐには戻らない');
  pl.tick(1 / 60, at + GAP * 1000 + 10);
  assert.equal(pl.game!.frame, 0);
  // ゲームのエラーで止まり、onCycle に理由
  p.registry.systems.push(boom(3));
  try {
    pl.build();
    pl.step(10);
    assert.equal(pl.game!.frame, 3);
    assert.match(pl.error, /システム boom でエラー: ばーん/);
    assert.match(cycles.at(-1)!.error!, /ばーん/);
  } finally {
    p.registry.systems.pop();
  }
  // 作れないときは理由
  const bad = new StagePlayer(() => startTrial(p.registry, p.config, { scene: 'nope' }), () => set);
  bad.build();
  assert.equal(bad.game, null);
  assert.match(bad.error, /シーン nope はありません/);
  await bad.seek(3);
});

/** 呼ばれた順に記録するだけの 2D の文脈 */
function fakeCtx() {
  const calls: unknown[][] = [];
  const props: Record<string, unknown> = {};
  const ctx = new Proxy({}, {
    get: (_, k) => (k in props ? props[k as string] : (...a: unknown[]) => { calls.push([k, ...a]); }),
    set: (_, k, v) => { props[k as string] = v; calls.push([`=${String(k)}`, v]); return true; },
  }) as CanvasRenderingContext2D;
  return { ctx, calls, props };
}

test('舞台の視点と描き込み: 自由な視点・座標の変換・大きさ（ワールド／画面の px）・当たり判定', async () => {
  // 自由な視点: 設計の画面全体が入る大きさを 1 として zoom 倍
  const design = { width: 480, height: 640 };
  const cam = freeView(design, 240, 320, { zoom: 0.5 });
  assert.equal(cam.zoom, 0.25);
  assert.deepEqual(canvasToWorld([cam], 240, 320, 0.5, 0.5), [240, 320]);
  assert.deepEqual(canvasToWorld([cam], 240, 320, 0, 0), [-240, -320]);
  assert.deepEqual(worldToScreen(cam, -240, -320), [0, 0]);
  assert.deepEqual(visibleRect(cam), { x: -240, y: -320, w: 960, h: 1280 });
  assert.deepEqual(freeView(design, 240, 320, { x: 0, y: 0 }).x, 0);
  assert.deepEqual(fitBox(1280, 720, 320, 320), { w: 320, h: 180 });
  // 手前のカメラから選ぶ（画面の右上の小さなカメラ）
  const main = { ...cam, zoom: 1, x: 120, y: 160 };
  const mini = { ...main, vx: 180, vy: 0, vw: 60, vh: 80, zoom: 0.1, x: 0, y: 0 };
  assert.deepEqual(canvasToWorld([main, mini], 240, 320, 0.875, 0.125), [0, 0]);
  assert.deepEqual(canvasToWorld([main, mini], 240, 320, 0.5, 0.5), [120, 160]);

  // 描き込み: 座標はワールド、太さ・破線・文字は画面の px（unit 倍）、px: true なら大きさも画面の px
  const { ctx, calls } = fakeCtx();
  const g = makeDraw(ctx, cam, 2, 2);
  g.circle(240, 320, 40, { color: '#ff0000', dash: [4, 2] });
  assert.deepEqual(calls.find((c) => c[0] === 'arc'), ['arc', 240, 320, 20, 0, Math.PI * 2]);
  assert.deepEqual(calls.find((c) => c[0] === 'setLineDash'), ['setLineDash', [8, 4]]);
  assert.ok(calls.some((c) => c[0] === '=lineWidth' && c[1] === 3));
  calls.length = 0;
  g.circle(240, 320, 6, { px: true, fill: '#fff' });
  assert.deepEqual(calls.find((c) => c[0] === 'arc'), ['arc', 240, 320, 12, 0, Math.PI * 2]);
  assert.ok(calls.some((c) => c[0] === 'fill') && calls.some((c) => c[0] === 'stroke'));
  calls.length = 0;
  g.rect(240, 320, 5, 5, { px: true, center: true, color: 'none', fill: '#fff' });
  assert.deepEqual(calls.find((c) => c[0] === 'rect'), ['rect', 235, 315, 10, 10]);
  assert.ok(!calls.some((c) => c[0] === 'stroke'), "color: 'none' なら線なし");
  calls.length = 0;
  g.rect(0, 0, 480, 640);
  assert.deepEqual(calls.find((c) => c[0] === 'rect'), ['rect', 120, 160, 240, 320]);
  calls.length = 0;
  g.polyline([0, 0, 480, 0, 480, 640], { closed: true });
  assert.deepEqual(calls.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo' || c[0] === 'closePath').map((c) => c[0]), ['moveTo', 'lineTo', 'lineTo', 'closePath']);
  calls.length = 0;
  g.text(240, 320, '敵1', { size: 12, align: 'center' });
  assert.ok(calls.some((c) => c[0] === '=font' && c[1] === '24px ui-monospace, monospace'));
  assert.deepEqual(calls.find((c) => c[0] === 'fillText'), ['fillText', '敵1', 240, 320]);

  // 当たり判定: Collider のある物ごとに1つ描く
  const p = await Project.load(await fresh());
  const t = startTrial(p.registry, p.config, { scene: 'main', spawn: [{ prefab: 'enemy' }] });
  const hits = fakeCtx();
  drawColliders(hits.ctx, t.game.world, [freeView(design, 480, 640)]);
  const n = [...t.game.world.entities.values()].filter((e) => e.c.Collider && e.c.Transform && !e.c.UI).length;
  assert.ok(n >= 2);
  assert.equal(hits.calls.filter((c) => c[0] === 'stroke').length, n);
});
