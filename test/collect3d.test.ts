// 見本 examples/collect3d（追加パッケージ 3d。3人称で物を集める）: 検証が通る・画面なしで遊べる・置き方に ⚠ がない・書き出せる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdCheck, cmdRun, cmdExport, packageCommands } = await import('../src/cli/ages.ts');

async function sample(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-c3d-')), 'collect3d');
  await cp(new URL('../examples/collect3d', import.meta.url), dir, { recursive: true });
  return dir;
}

test('collect3d: 検証が通り、置き方に ⚠ がない（ages space）', async () => {
  const dir = await sample();
  assert.match(await cmdCheck(dir), /^ok（シーン1 プレハブ12 /);
  const space = (await packageCommands(dir)).find((c) => c.name === 'space')!;
  const out = await space.run(dir, {});
  assert.doesNotMatch(out, /⚠/);
  // 主人公は島の上に立ち、画面の真ん中あたりに映っている。コインは足場の少し上に浮いている
  assert.match(out, /^ {2}player character\.glb .* 底y=0\.5 island の上 ｜ 画面\(480,\d+\) 高さ\d+px/m);
  assert.equal(out.split('\n').filter((l) => /^ {2}coin\d .* の 0\.3 上に浮く/.test(l)).length, 8);
});

test('collect3d: 画面なしで遊べる（歩く・壁で止まる・跳んで足場とレンガに乗る・コインを拾う）。毎回同じ結果', async () => {
  const dir = await sample();
  const run = async (keys: string, frames: number, watch: string) => {
    const out = await cmdRun(dir, { frames: String(frames), keys, watch, twice: true });
    assert.match(out, /再現性: OK/);
    return { out, end: (name: string) => new RegExp(`watch player\\.${name.replaceAll('.', '\\.')}: .* → (.*)$`, 'm').exec(out)?.[1] };
  };
  // 右へ歩いてコイン、跳んで隣の足場（高さ 0.95）に乗り、その上のコインも拾う
  let r = await run('0-21:@move_x=1;21-32:@move_y=1;32-67:@move_x=1;42-43:@jump;67-78:@move_y=-1', 120, 'player.Player.coins,player.Transform3D.y,player.Player.grounded,player.Model3D.clip');
  assert.deepEqual([r.end('Player.coins'), r.end('Player.grounded'), r.end('Model3D.clip')], ['2', 'true', 'idle']);
  assert.ok(Math.abs(Number(r.end('Transform3D.y')) - 0.95) < 1e-9);
  assert.match(r.out, /events: coin×2/);
  assert.match(r.out, /sounds: .*♪se_coin×2.*♪se_jump×1|sounds: .*♪se_jump×1.*♪se_coin×2/);
  // 奥へ歩くと、レンガの壁で止まる（レンガの手前の面 z = -0.9 から、体の半分 0.3 手前）
  r = await run('0-60:@move_y=-1', 80, 'player.Transform3D.z');
  assert.ok(Math.abs(Number(r.end('Transform3D.z')) + 0.6) < 0.08, String(r.end('Transform3D.z')));
  // レンガを2段のぼって、上のコインを拾う（高さ 2.5）
  r = await run('0-16:@move_x=-1;20-21:@jump;24-43:@move_y=-1;80-81:@jump;84-98:@move_x=1', 200, 'player.Player.coins,player.Transform3D.y');
  assert.deepEqual([r.end('Player.coins'), r.end('Transform3D.y')], ['1', '2.5']);
  // 足場の外へ歩くと落ちて、始めの場所に戻る
  r = await run('0-200:@move_y=1', 200, 'player.Transform3D.z,player.Transform3D.y');
  assert.match(r.out, /♪se_fall×\d/);
  // 終わりを省いたボタンをもう一度書くと、直し方つきで止まる
  await assert.rejects(cmdRun(dir, { frames: '100', keys: '20:@jump;80:@jump' }), /Space は 20 フレーム目から押したままです.*20-21:… と 80-81:…/);
});

test('collect3d: 書き出したものが headless の Chrome で動く（モデル・画像・音・3D のパッケージ込み）', { skip: (await import('../src/cli/shot.ts')).findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = await sample();
  const out = await cmdExport(dir, { check: true });
  assert.match(out, /確かめました: headless の Chrome で \d+フレーム（約\d+秒）進み、エラーなし（シーン main）/);
});
