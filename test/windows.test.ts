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
const keeper = { who: 'yamamoto', kind: 'human' as const, win: 'lock-manager' };
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
  await p.lock(['@enemy.Health.hp'], keeper);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Health.hp', value: 4 }], viaWindow), /🔒 ロックされた値は、ウインドウ wave-tuner からは変えられません: @enemy\.Health\.hp/);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Health.hp', value: 4 }], human), /ロックマネージャーで/, '人もエディタからは変えられない');
  await p.apply([{ op: 'set', path: '@enemy.Health.hp', value: 4 }], keeper);
  assert.equal(JSON.parse(await readFile(join(dir, 'prefabs/enemy.prefab.json'), 'utf8')).components.Health.hp, 4, 'ロックマネージャーからなら変えられる');
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
  assert.match(out, /bare\.window\.ts: desc（何のための拡張か、1行）がありません/);
  assert.match(out, /bare\.window\.ts: edits（パネルが変える値の住所）がありません/);
  assert.match(out, /typo\.window\.ts: edits の main#spawnr\.Spawner\.\*: シーン main に spawnr はありません/);
  assert.match(out, /typo\.window\.ts: edits の @enemy\.Helth\.hp: .*もしかして: Health/);
  assert.match(out, /typo\.window\.ts: edits の \$enemies\.basic\.hpp: 表 enemies に列 hpp はありません。もしかして: hp/);
  assert.match(out, /editor\/forgot\.window\.ts: ages\.project\.json の editorWindows に書いていない/);
  assert.match(await cmdMap(dir), /editor\/broken\.window\.ts ⚠ 読み込めません/);
});

test('拡張の欄・部品の見せ方: 地図に窓口が出て、見せている欄・部品だけを edits なしで変えられる', async () => {
  const dir = await fresh();
  await writeFile(join(dir, 'editor/tint.ext.ts'), "import { defineExtension } from 'ages';\nexport default defineExtension({ id: 'tint', desc: '色の欄を見本つきで', fields: [{ match: 'color', mount() {} }], components: [{ component: 'UI', mount() {} }] });\n");
  const cfg = join(dir, 'ages.project.json');
  const c = JSON.parse(await readFile(cfg, 'utf8'));
  c.editorWindows.push('editor/tint.ext.ts');
  await writeFile(cfg, JSON.stringify(c, null, 2));
  const map = await cmdMap(dir);
  assert.match(map, /^hp-hearts 体力（Health\.hp）を ♥ の数で見せ、−・＋ で1つずつ変える \| 欄:Health\.hp \| editor\/hp-hearts\.ext\.ts$/m);
  assert.match(map, /^tint 色の欄を見本つきで \| 欄:color 部品:UI \| editor\/tint\.ext\.ts$/m);
  const p = await Project.load(dir);
  const hearts = { who: 'yamamoto', kind: 'human' as const, win: 'window:hp-hearts' };
  const tint = { who: 'yamamoto', kind: 'human' as const, win: 'window:tint' };
  await p.apply([{ op: 'set', path: '@enemy.Health.hp', value: 5 }, { op: 'set', path: 'main#player.Health.hp', value: 4 }], hearts);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Velocity.vy', value: 3 }], hearts), /宣言（edits）にない値を変えようとしています: @enemy\.Velocity\.vy/);
  await p.apply([{ op: 'set', path: '@enemy.Sprite.tint', value: '#ff0000' }, { op: 'dockUI', target: 'main#hpGauge', edge: 'topLeft' }], tint);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Sprite.alpha', value: 0.5 }], tint), /宣言（edits）にない値/);
  await p.lock(['@enemy.Health.hp'], keeper);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Health.hp', value: 6 }], hearts), /🔒 ロックされた値は、ウインドウ hp-hearts からは変えられません/);
});

test('拡張の検証: 窓口がない・ない型・ない部品とフィールド', async () => {
  const dir = await fresh();
  await writeFile(join(dir, 'editor/bad.ext.ts'), "import { defineExtension } from 'ages';\nexport default defineExtension({ id: 'bad', desc: 'x', fields: [{ match: ['colr', 'Helth.hp', 'Health.hpp', 'main#nai.Health.hp'], mount() {} }], components: [{ component: 'UIX', mount() {} }] });\n");
  await writeFile(join(dir, 'editor/empty.ext.ts'), "import { defineExtension } from 'ages';\nexport default defineExtension({ id: 'empty', desc: 'x' });\n");
  const cfg = join(dir, 'ages.project.json');
  const c = JSON.parse(await readFile(cfg, 'utf8'));
  c.editorWindows.push('editor/bad.ext.ts', 'editor/empty.ext.ts');
  await writeFile(cfg, JSON.stringify(c, null, 2));
  const out = await cmdCheck(dir);
  assert.match(out, /bad\.ext\.ts: fields の match colr: 型 colr はありません。もしかして: color/);
  assert.match(out, /bad\.ext\.ts: fields の match Helth\.hp: 部品 Helth はありません。もしかして: Health/);
  assert.match(out, /bad\.ext\.ts: fields の match Health\.hpp: Health に hpp はありません。もしかして: hp/);
  assert.match(out, /bad\.ext\.ts: fields の match main#nai\.Health\.hp: シーン main にエンティティ nai はありません/);
  assert.match(out, /bad\.ext\.ts: components の UIX: 部品 UIX はありません。もしかして: UI/);
  assert.match(out, /empty\.ext\.ts: 窓口がありません/);
  assert.doesNotMatch(out, /empty\.ext\.ts: (title|edits)/);
});

test('拡張の右クリックのメニュー: 地図に項目の名前が出て、窓口として数える', async () => {
  const dir = await fresh();
  await writeFile(join(dir, 'editor/menu.ext.ts'), "import { defineExtension } from 'ages';\nexport default defineExtension({ id: 'line-up', desc: '選んだ物を横に並べる', edits: [], menus: [{ label: '横に並べる', where: 'entity', run() {} }] });\n");
  const cfg = join(dir, 'ages.project.json');
  const c = JSON.parse(await readFile(cfg, 'utf8'));
  c.editorWindows.push('editor/menu.ext.ts');
  await writeFile(cfg, JSON.stringify(c, null, 2));
  assert.match(await cmdMap(dir), /^line-up 選んだ物を横に並べる \| 変える: なし（見るだけ） \| メニュー:横に並べる \| editor\/menu\.ext\.ts$/m);
  assert.doesNotMatch(await cmdCheck(dir), /menu\.ext\.ts/);
});
