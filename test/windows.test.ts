// プロジェクト独自のエディタ（ウインドウ）: 地図への宣言・検証・変えられる値の制限
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { cmdCheck, cmdMap } from '../src/cli/ages.ts';
import { compactPaths } from '../src/project/map.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const human = { who: 'yamamoto', kind: 'human' as const, win: 'inspector' };
const viaWindow = { who: 'yamamoto', kind: 'human' as const, win: 'window:wave-tuner' };

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

test('地図には、ウインドウの宣言（名前・説明・変える値）が1行で出る', async () => {
  const map = await cmdMap(await fresh());
  assert.match(map, /wave-tuner「敵の出方」 敵の出方（間隔・速さ・体力）をまとめて調整し、自動操作で30秒を試す \| 変える: main#spawner\.Spawner\.\{interval,speedMin,speedMax\} @enemy\.Health\.hp \| editor\/wave-tuner\.window\.ts/);
  assert.equal(compactPaths(['a#b.C.x', 'a#b.C.y', '@e.*', '$t.r.c']), 'a#b.C.{x,y} @e.* $t.r.c');
});

test('ウインドウからは、宣言した値だけを変えられ、ロックされた値は変えられない', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'set', path: '@enemy.Health.hp', value: 3 }], viaWindow);
  await assert.rejects(p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 9 }], viaWindow), /ウインドウ wave-tuner は、宣言（edits）にない値を変えようとしています: main#player\.Player\.speed/);
  await p.lock(['@enemy.Health.hp'], human);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Health.hp', value: 4 }], viaWindow), /🔒 ロックされた値は、ウインドウ wave-tuner からは変えられません: @enemy\.Health\.hp/);
  await p.apply([{ op: 'set', path: '@enemy.Health.hp', value: 4 }], human);
  assert.equal(JSON.parse(await readFile(join(dir, 'prefabs/enemy.prefab.json'), 'utf8')).components.Health.hp, 4, '人はインスペクタからなら変えられる');
});

test('検証: 読み込めない・書き忘れ・ない住所・id の重複・登録し忘れを知らせる', async () => {
  const dir = await fresh();
  await writeFile(join(dir, 'editor/broken.window.ts'), "document.title = 'x';\nexport default {};\n");
  await writeFile(join(dir, 'editor/bare.window.ts'), "import { defineWindow } from 'ages';\nexport default defineWindow({ id: 'wave-tuner', title: '', mount() {} });\n");
  await writeFile(join(dir, 'editor/typo.window.ts'), "import { defineWindow } from 'ages';\nexport default defineWindow({ id: 'typo', title: 'x', desc: 'x', edits: ['main#spawnr.Spawner.*', '@enemy.Helth.hp', '$enemies.basic.hpp'], mount() {} });\n");
  await writeFile(join(dir, 'editor/forgot.window.ts'), "export default { id: 'f', title: 'f', desc: 'f', edits: [], mount() {} };\n");
  const cfg = join(dir, 'ages.project.json');
  const c = JSON.parse(await readFile(cfg, 'utf8'));
  c.editorWindows.push('editor/broken.window.ts', 'editor/bare.window.ts', 'editor/typo.window.ts');
  await writeFile(cfg, JSON.stringify(c, null, 2));
  const out = await cmdCheck(dir);
  assert.match(out, /editor\/broken\.window\.ts: 読み込めません（モジュールの一番外で document/);
  assert.match(out, /editor\/bare\.window\.ts: id wave-tuner は editor\/wave-tuner\.window\.ts と同じです/);
  assert.match(out, /bare\.window\.ts: title がありません/);
  assert.match(out, /bare\.window\.ts: desc（何のためのウインドウか、1行）がありません/);
  assert.match(out, /bare\.window\.ts: edits（変える値の住所）がありません/);
  assert.match(out, /typo\.window\.ts: edits の main#spawnr\.Spawner\.\*: シーン main に spawnr はありません/);
  assert.match(out, /typo\.window\.ts: edits の @enemy\.Helth\.hp: .*もしかして: Health/);
  assert.match(out, /typo\.window\.ts: edits の \$enemies\.basic\.hpp: 表 enemies に列 hpp はありません。もしかして: hp/);
  assert.match(out, /editor\/forgot\.window\.ts: ages\.project\.json の editorWindows に書いていない/);
  assert.match(await cmdMap(dir), /editor\/broken\.window\.ts ⚠ 読み込めません/);
});
