// ages run --shot: そのフレームの画面を headless の Chrome で撮る。Chrome がない環境では飛ばす
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdRun } from '../src/cli/ages.ts';
import { findChrome, shotTimeout } from '../src/cli/shot.ts';
import { decodePng } from '../src/project/png.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));

test('ages run --shot: ages run と同じ入力で、そのフレームの画面を PNG に（状態の hash も同じ）', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  const out = await cmdRun(dir, { frames: '200', keys: '0-200:@fire;0-80:@move_x=-1', shot: '0,120', 'shot-scale': '0.5' });
  assert.match(out, /^shot f0: \.ages\/shots\/main-f0\.png 240x320$/m);
  assert.match(out, /^shot f120: \.ages\/shots\/main-f120\.png 240x320$/m, '画面のページの状態が ages run と同じ（⚠ が付かない）');
  const png = decodePng(await readFile(join(dir, '.ages/shots/main-f120.png')));
  assert.equal(png.w, 240);
  assert.equal(png.h, 320);
  // 何か描かれている（背景だけではない）
  const colors = new Set<number>();
  for (let i = 0; i < png.data.length; i += 4 * 97) colors.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
  assert.ok(colors.size > 4);
  // 届かないフレームは撮らずに知らせる
  assert.match(await cmdRun(dir, { frames: '10', shot: '50' }), /⚠ shot f50: そのフレームまで進んでいません/);
  await assert.rejects(cmdRun(dir, { frames: '10', shot: 'x' }), /--shot の x はフレームの番号ではありません/);
  await rm(dir, { recursive: true, force: true });
});

test('ages run --shot: 時間の上限は枚数に合わせて延びる。時間切れでも撮れた分は残し、どこで止まったかを出す（#158）', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  assert.ok(shotTimeout({ frames: Array.from({ length: 30 }, (_, i) => i * 60) } as never) > shotTimeout({ frames: [0] } as never) + 150_000);
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  const out = await cmdRun(dir, { frames: '400', shot: '0-390:2', 'shot-timeout': '0.5' });
  const m = /⚠ 時間切れ（1秒）: 196枚のうち (\d+)枚を撮りました（f(\d+) まで進めた）。残り (\d+)枚/.exec(out);
  assert.ok(m, out.slice(-400));
  assert.equal(Number(m[1]) + Number(m[3]), 196);
  assert.equal((out.match(/^shot f\d+: /gm) ?? []).length, Number(m[1]), '撮れた分はファイルに置いた');
  await rm(dir, { recursive: true, force: true });
});
