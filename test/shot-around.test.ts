// ages run --shot の範囲・--shot-around（物のまわりを切り抜いて拡大）・--shot-sheet（並べた1枚）（issue #126）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdRun } = await import('../src/cli/ages.ts');
const { findChrome } = await import('../src/cli/shot.ts');
const { decodePng } = await import('../src/project/png.ts');

async function copy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-around-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

test('書き方の誤りは、撮る前に分かる', async () => {
  const dir = await copy();
  await assert.rejects(cmdRun(dir, { frames: '10', shot: '5', 'shot-around': 'player' }), /--shot-around は 物,幅x高さ,x倍率/);
  await assert.rejects(cmdRun(dir, { frames: '10', shot: '5', 'shot-around': 'player,64x64,x9' }), /倍率は x1〜x8/);
  await assert.rejects(cmdRun(dir, { frames: '10', shot: '9-3' }), /--shot の 9-3: 始め-終わり:何フレームごと/);
  await assert.rejects(cmdRun(dir, { frames: '10', shot: '0-200' }), /--shot が 201 枚です（64 枚まで/);
});

test('切り抜いて整数倍に（にじまない）・並べた1枚にフレームの番号', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = await copy();
  let out = await cmdRun(dir, { frames: '30', shot: '20', 'shot-around': 'player,40x30,x4' });
  const m = /^shot f20: \.ages\/shots\/main-f20-around\.png 160x120 player のまわり（真ん中 (\d+),(\d+)）$/m.exec(out);
  assert.ok(m, out);
  const one = decodePng(await readFile(join(dir, '.ages', 'shots', 'main-f20-around.png')));
  assert.deepEqual([one.w, one.h], [160, 120]);
  // 最近傍: 4×4 の区切りの中は同じ色
  const px = (x: number, y: number) => [...one.data.subarray((y * one.w + x) * 4, (y * one.w + x) * 4 + 3)].join();
  for (const [x, y] of [[80, 60], [40, 40], [100, 72]]) {
    const bx = x - (x % 4), by = y - (y % 4);
    assert.equal(px(bx + 3, by + 3), px(bx, by), `${x},${y} の区切り`);
  }
  // 画面全体と比べて、真ん中の色が同じ
  await cmdRun(dir, { frames: '30', shot: '20' });
  const full = decodePng(await readFile(join(dir, '.ages', 'shots', 'main-f20.png')));
  const [cx, cy] = [Number(m[1]), Number(m[2])];
  assert.equal(px(80, 60), [...full.data.subarray((cy * full.w + cx) * 4, (cy * full.w + cx) * 4 + 3)].join());

  // いない物・画面の点
  out = await cmdRun(dir, { frames: '30', shot: '20', 'shot-around': 'nobody,40x30' });
  assert.match(out, /nobody のまわり（真ん中 \d+,\d+）⚠ nobody がいないので、画面の真ん中/);
  out = await cmdRun(dir, { frames: '30', shot: '20', 'shot-around': '100:50,40x30,x2' });
  assert.match(out, /100:50 のまわり（真ん中 100,50）/);

  // 並べる: 1枚ずつは置かない
  await rm(join(dir, '.ages', 'shots'), { recursive: true, force: true });
  out = await cmdRun(dir, { frames: '40', shot: '20-32:4', 'shot-around': 'player,40x30,x2', 'shot-sheet': true });
  assert.match(out, /^shot 4枚を並べた1枚: \.ages\/shots\/main-f20-f32-around-sheet\.png 332x60（4列×1行。左上がフレームの番号）$/m, out);
  assert.deepEqual(await readdir(join(dir, '.ages', 'shots')), ['main-f20-f32-around-sheet.png']);
  const sheet = decodePng(await readFile(join(dir, '.ages', 'shots', 'main-f20-f32-around-sheet.png')));
  assert.deepEqual([sheet.w, sheet.h], [332, 60]);
  // 画面まるごとでも並べられる（幅 2048 を超えたら折り返す）
  out = await cmdRun(dir, { frames: '40', shot: '10,20,30', 'shot-sheet': true, 'shot-scale': '0.5' });
  assert.match(out, /^shot 3枚を並べた1枚: \.ages\/shots\/main-f10-f30-sheet\.png \d+x\d+（[13]列×[13]行/m);
});
