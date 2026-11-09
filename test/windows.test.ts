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

/** 拡張を1つ足して読み込む（edits と窓口はそのまま書く） */
async function withExt(id: string, decl: string): Promise<{ dir: string; p: Project; actor: { who: string; kind: 'human'; win: string } }> {
  const dir = await fresh();
  await writeFile(join(dir, `editor/${id}.ext.ts`), `import { defineExtension } from 'ages';\nexport default defineExtension({ id: '${id}', ${decl} });\n`);
  const cfg = join(dir, 'ages.project.json');
  const c = JSON.parse(await readFile(cfg, 'utf8'));
  c.editorWindows.push(`editor/${id}.ext.ts`);
  await writeFile(cfg, JSON.stringify(c, null, 2));
  return { dir, p: await Project.load(dir), actor: { who: 'yamamoto', kind: 'human', win: `window:${id}` } };
}
const exists = async (path: string) => readFile(path).then(() => true, () => false);

test('edits の @[タグ]: そのタグのプレハブを作る・写す・名前を変える・元を変える・部品を付け外す・消す。前も後もタグを持つものだけ', async () => {
  const { dir, p, actor } = await withExt('foes', "title: '敵', desc: '敵のプレハブの管理', edits: ['@[enemy]'], panel: { mount() {} }");
  const tags = (n: string) => p.registry.findPrefab(n)?.tags;
  await p.apply([{ op: 'addPrefab', name: 'foe2', copy: 'enemy' }, { op: 'addPrefab', name: 'foe3', base: 'enemy', components: { Health: { hp: 7 } } }], actor);
  assert.deepEqual(tags('foe2'), ['enemy']);
  assert.deepEqual(tags('foe3'), ['enemy'], '派生は元のタグを受け継ぐ');
  await p.apply([{ op: 'set', path: '@foe3.Health.hp', value: 8 }, { op: 'addComponent', target: '@foe2', component: 'Lifetime' }, { op: 'removeComponent', target: '@foe2', component: 'Velocity' }], actor);
  await p.apply([{ op: 'revert', path: '@foe3.Health.hp' }, { op: 'addPrefab', name: 'foe4', tags: ['enemy', 'boss'] }], actor);
  await p.apply([{ op: 'renamePrefab', name: 'foe2', to: 'foe2b' }, { op: 'setPrefab', name: 'foe2b', base: 'enemy', desc: '写しを派生に' }], actor);
  assert.ok(await exists(join(dir, 'prefabs/foe2b.prefab.json')));
  assert.ok(!(await exists(join(dir, 'prefabs/foe2.prefab.json'))));
  assert.equal(p.docs.prefabs.get('foe2b')!.base, 'enemy');
  await p.apply([{ op: 'removePrefab', name: 'foe2b' }], actor);
  // よそのプレハブ（タグがない）は変えられない。タグを付けてから変えることもできない
  await assert.rejects(p.apply([{ op: 'set', path: '@bullet.Bullet.damage', value: 2 }], actor), /edits）にない値を変えようとしています: @bullet\.Bullet\.damage。.*@\[タグ\] で変えられるのは、変える前からそのタグを持つプレハブと、新しく作るプレハブ/);
  await assert.rejects(p.apply([{ op: 'setPrefab', name: 'bullet', tags: ['enemy'] }, { op: 'set', path: '@bullet.Bullet.damage', value: 2 }], actor), /にない値を変えようとしています: @bullet/);
  await assert.rejects(p.apply([{ op: 'renamePrefab', name: 'bullet', to: 'shot' }], actor), /にない値を変えようとしています: @bullet/);
  await assert.rejects(p.apply([{ op: 'removePrefab', name: 'bullet' }], actor), /にない値/);
  // タグの外へ出る（タグを外す・タグのないものを作る・写す）は、変えた後で止めて何も変えない
  await assert.rejects(p.apply([{ op: 'setPrefab', name: 'foe3', tags: ['bullet'] }], actor), /@\[タグ\] の外へ出るプレハブがあります: @foe3（タグ enemy がなくなる）/);
  await assert.rejects(p.apply([{ op: 'addPrefab', name: 'x', copy: 'bullet' }], actor), /外へ出る.*@x/);
  await assert.rejects(p.apply([{ op: 'addPrefab', name: 'y', tags: ['enemy'] }, { op: 'setPrefab', name: 'y', tags: [] }], actor), /外へ出る.*@y/);
  assert.deepEqual(tags('foe3'), ['enemy']);
  assert.ok(!p.docs.prefabs.has('x') && !(await exists(join(dir, 'prefabs/x.prefab.json'))));
  // 🔒 は今までどおり拡張からは変えられない（中にロックがあるプレハブは、名前も変えられない）
  await p.lock(['@foe3.Health.hp'], keeper);
  await assert.rejects(p.apply([{ op: 'set', path: '@foe3.Health.hp', value: 1 }], actor), /🔒 ロックされた値は、ウインドウ foes からは変えられません/);
  await assert.rejects(p.apply([{ op: 'renamePrefab', name: 'foe3', to: 'foe5' }], actor), /🔒/);
  await assert.rejects(p.apply([{ op: 'removePrefab', name: 'foe3' }], actor), /🔒/);
});

test('edits の @[タグ].部品.*: そのタグのプレハブの、その部品の値だけ（プレハブそのものの操作はできない）', async () => {
  const { p, actor } = await withExt('hp', "title: '体力', desc: '敵の体力', edits: ['@[enemy].Health.*'], panel: { mount() {} }");
  await p.apply([{ op: 'addPrefab', name: 'foe2', base: 'enemy' }], { who: 'yamamoto', kind: 'human', win: 'inspector' });
  await p.apply([{ op: 'set', path: '@enemy.Health.hp', value: 4 }, { op: 'set', path: '@foe2.Health.hp', value: 6 }, { op: 'revert', path: '@foe2.Health.hp' }], actor);
  await p.apply([{ op: 'removeComponent', target: '@foe2', component: 'Health' }, { op: 'addComponent', target: '@foe2', component: 'Health', values: { hp: 9 } }], actor);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Velocity.vy', value: 3 }], actor), /にない値を変えようとしています: @enemy\.Velocity\.vy/);
  await assert.rejects(p.apply([{ op: 'addPrefab', name: 'foe3', copy: 'enemy' }], actor), /にない値を変えようとしています: @foe3/);
  await assert.rejects(p.apply([{ op: 'setPrefab', name: 'foe2', desc: 'x' }], actor), /にない値/);
});

test('edits の $表.*: 表の行を足す・動かす・名前を変える・消す。行1つの edits では、名前を変えて外へ出られない', async () => {
  const { p, actor } = await withExt('rows', "title: '敵の表', desc: '敵の表の行', edits: ['$enemies.*'], panel: { mount() {} }");
  await p.apply([{ op: 'addRow', table: 'enemies', row: { id: 'boss', hp: 30 } }, { op: 'moveRow', table: 'enemies', id: 'boss', to: 0 }], actor);
  await p.apply([{ op: 'renameRow', table: 'enemies', id: 'boss', to: 'boss2' }, { op: 'set', path: '$enemies.boss2.hp', value: 40 }], actor);
  await p.apply([{ op: 'removeRow', table: 'enemies', id: 'boss2' }], actor);
  assert.deepEqual(p.docs.tables.get('enemies')!.rows.map((r) => r.id), ['basic', 'fast', 'tough']);
  const one = await withExt('row1', "title: '1行', desc: '1行', edits: ['$enemies.fast.*'], panel: { mount() {} }");
  await one.p.apply([{ op: 'set', path: '$enemies.fast.hp', value: 2 }], one.actor);
  await assert.rejects(one.p.apply([{ op: 'renameRow', table: 'enemies', id: 'fast', to: 'quick' }], one.actor), /にない値を変えようとしています: \$enemies\.quick/);
});

test('地図と ages check: @[タグ] にプレハブの数。ないタグは ⚠（もしかして）、ない部品・空のタグは error', async () => {
  const { dir } = await withExt('foes', "title: '敵', desc: '敵の管理', edits: ['@[enemy]', '@[enemey]', '@[enemy].Helth.*', '@[]', '$enemies.*'], panel: { mount() {} }");
  assert.match(await cmdMap(dir), /^foes「敵」 敵の管理 \| 変える: @\[enemy\]（1個） @\[enemey\]（⚠ まだ0個） @\[enemy\]（1個）\.Helth\.\* @\[\]（⚠ まだ0個） \$enemies\.\* \| editor\/foes\.ext\.ts$/m);
  const out = await cmdCheck(dir);
  assert.match(out, /^⚠ editor\/foes\.ext\.ts: edits の @\[enemey\]: タグ enemey のプレハブがまだありません。もしかして: enemy/m);
  assert.match(out, /^error: editor\/foes\.ext\.ts: edits の @\[enemy\]\.Helth\.\*: 部品 Helth はありません。もしかして: Health/m);
  assert.match(out, /^error: editor\/foes\.ext\.ts: edits の @\[\]: @\[タグ\] のタグがありません/m);
  assert.doesNotMatch(out, /edits の @\[enemy\]:|edits の \$enemies/);
});

test('プレハブの名前は renamePrefab で変える（rename はシーンの物だけ。ファイルと参照がずれないように）', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  const human = { who: 'yamamoto', kind: 'human' as const, win: 'inspector' };
  await assert.rejects(p.apply([{ op: 'rename', target: '@enemy', name: 'foe' }], human), /プレハブの名前は renamePrefab で変えます（\{"op":"renamePrefab","name":"enemy","to":"foe"\}/);
  assert.equal(JSON.parse(await readFile(join(dir, 'prefabs/enemy.prefab.json'), 'utf8')).name, 'enemy');
  await p.apply([{ op: 'rename', target: 'main#player', name: '自機' }], human);
});

test('本体の拡張: 階層のプレハブの右クリック（写す・名前を変える・削除）は where: prefab の menus', async () => {
  const { default: ext } = await import('../src/editor/builtin/prefab-menu.ts');
  const sent: unknown[] = [];
  const picked: (string | null)[] = [];
  const api = {
    playing: false, state: { prefabs: { enemy: {}, enemy_copy: {} } },
    ask: async (_t: string, v: string) => v === 'enemy' ? 'foe' : v,
    patch: async (ops: unknown[]) => { sent.push(...ops); return []; },
    select: (a: string | null) => { picked.push(a); },
  } as never;
  assert.deepEqual(ext.menus!.map((m) => [m.label, m.where]), [['写す', 'prefab'], ['名前を変える', 'prefab'], ['削除', 'prefab']]);
  globalThis.confirm = () => true;
  for (const m of ext.menus!) await m.run(['@enemy'], api);
  assert.deepEqual(sent, [{ op: 'addPrefab', name: 'enemy_copy2', copy: 'enemy' }, { op: 'renamePrefab', name: 'enemy', to: 'foe' }, { op: 'removePrefab', name: 'enemy' }]);
  assert.deepEqual(picked, ['@enemy_copy2', '@foe', null]);
});
