// 試し: プレハブだけを空のシーンに出して動かす（エディタの「試し」の窓と ages run --spawn）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdRun } from '../src/cli/ages.ts';
import { parseSpawns } from '../src/core/tryout.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

test('出すものの書き方: 名前と、真ん中からのずれ', () => {
  assert.deepEqual(parseSpawns('enemy,explosion@40,-20, se_shot'), [{ prefab: 'enemy' }, { prefab: 'explosion', x: 40, y: -20 }, { prefab: 'se_shot' }]);
});

test('ages run --spawn: プレハブだけを真ん中に出し、消えたら止まる。粒・音・再現性も分かる', async () => {
  const dir = await fresh();
  const boom = await cmdRun(dir, { spawn: 'explosion', frames: '300', twice: true });
  assert.match(boom, /^run 試し\(@explosion\) seed1 20f .*停止:出した物がすべて消えた @f20/);
  assert.match(boom, /particles: ✦explosion×1/);
  assert.match(boom, /再現性: OK/);
  // 動く物は、ゲームと同じシステムで動く（画面の外に出ると消える）。watch も使える
  const enemy = await cmdRun(dir, { spawn: 'enemy', frames: '600', watch: 'enemy~1.Transform.y' });
  assert.match(enemy, /停止:出した物がすべて消えた @f\d+/);
  assert.match(enemy, /watch enemy~1\.Transform\.y: 320 → —/);
  // @プレハブ名 なら ID を探さずに、いる最初の1つを見る。リストの値は始めと今で別々に写す
  const by = await cmdRun(dir, { spawn: 'enemy', frames: '10', watch: '@enemy.Transform.y,@enemy.Sprite.size' });
  assert.match(by, /watch @enemy\.Transform\.y: 320 → 3\d\d/);
  assert.match(by, /watch @enemy\.Sprite\.size: \[0,0\] → \[0,0\]/);
  // 音のプレハブは1回鳴らす
  assert.match(await cmdRun(dir, { spawn: 'se_shot', frames: '30' }), /sounds: ♪se_shot×1/);
  await assert.rejects(cmdRun(dir, { spawn: 'enemmy' }), /プレハブ enemmy はありません。もしかして: enemy/);
});
