// スクリプトの調整値（defineParams と params 型の欄。issue #161）: 形で中身が変わる欄・1つずつの上書き・ロック・検証・schema
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { cmdSchema } from '../src/cli/ages.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const keeper = { who: 'yamamoto', kind: 'human' as const, win: 'lock-manager' };
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  await writeFile(join(dir, 'game', 'script.ts'), `import { defineComponent, defineParams } from 'ages';
export const Script = defineComponent({
  name: 'Script',
  desc: '物ごとのふるまい',
  fields: {
    script: { type: 'string', default: '', desc: 'ふるまいの名前' },
    params: { type: 'params', of: 'script', desc: 'ふるまいの調整値' },
  },
});
export const sweep = defineParams({
  name: 'sweep',
  desc: '扇に撃つ',
  fields: {
    angle: { type: 'number', default: 45, min: 0, max: 360, label: '回る角度', desc: '撃ち始めから終わりまでの角度（度）' },
    time: { type: 'number', default: 1, min: 0, max: 30, desc: '回る秒数' },
  },
});
`);
  const idx = join(dir, 'game', 'index.ts');
  const src = (await readFile(idx, 'utf8')).replace("export const components: GameModule['components'] = Object.values(C);", "import { Script, sweep } from './script.ts';\nexport const components: GameModule['components'] = [...Object.values(C), Script];\nexport const params: GameModule['params'] = [sweep];");
  await writeFile(idx, src);
  return dir;
}

test('調整値: 選んだ名前の形で欄が並び、範囲・形にない名前を知らせる。schema で引ける', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'addComponent', target: '@enemy', component: 'Script', values: { script: 'sweep' } }], ai);
  await p.apply([{ op: 'set', path: '@enemy.Script.params.angle', value: 90 }], ai);
  assert.deepEqual(p.docs.prefabs.get('enemy')!.components.Script.params, { angle: 90 });
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Script.params.angle', value: 999 }], ai), /angle/);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Script.params.nope', value: 1 }], ai), /nope という項目はありません.*angle, time/);
  // 動かすと、省いた値は既定値で埋まる
  const g = p.newGame();
  const e = g.world.spawn('enemy');
  assert.deepEqual(e.c.Script.params, { angle: 90, time: 1 });
  // schema: 一覧と中身（見せる名前「」つき）
  assert.match(await cmdSchema(dir, ['params']), /調整値の形.*sweep（扇に撃つ）/);
  const sc = await cmdSchema(dir, ['params:sweep']);
  assert.match(sc, /angle「回る角度」 num 0\.\.360=45 — 撃ち始め/);
  assert.match(sc, /使う欄: Script\.params（Script\.script で選ぶ）/);
  await assert.rejects(cmdSchema(dir, ['params:swep']), /sweep/);
});

test('調整値: 派生・置いた物では1つずつ上書きでき、元の変更はほかの値に届く。1つずつ戻せる', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'addComponent', target: '@enemy', component: 'Script', values: { script: 'sweep', params: { angle: 90, time: 2 } } }, { op: 'addPrefab', name: 'enemy2', base: 'enemy' }], ai);
  await p.apply([{ op: 'set', path: '@enemy2.Script.params.time', value: 5 }], ai);
  assert.deepEqual(p.docs.prefabs.get('enemy2')!.components.Script, { params: { time: 5 } }, '変えた1つだけを書く');
  const r = await p.apply([{ op: 'set', path: '@enemy.Script.params.angle', value: 120 }], ai);
  assert.ok(r.changes.some((c) => c.path === '@enemy2.Script.params.angle' && c.auto), JSON.stringify(r.changes));
  assert.deepEqual(p.newGame().world.spawn('enemy2').c.Script.params, { angle: 120, time: 5 });
  // 置いた物も1つだけ
  await p.apply([{ op: 'addEntity', scene: 'main', entity: { id: 'e9', prefab: 'enemy2' } }], ai);
  await p.apply([{ op: 'set', path: 'main#e9.Script.params.angle', value: 10 }], ai);
  assert.deepEqual(p.docs.scenes.get('main')!.entities.find((x) => x.id === 'e9')!.components.Script, { params: { angle: 10 } });
  // 1つずつ戻す
  await p.apply([{ op: 'revert', path: '@enemy2.Script.params.time' }], ai);
  assert.equal(p.docs.prefabs.get('enemy2')!.components.Script, undefined);
});

test('調整値: 1つだけロックできる（ほかの値は変えられる）。名前を変えても書いた値は消えず、検証が知らせる', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'addComponent', target: '@enemy', component: 'Script', values: { script: 'sweep', params: { angle: 90 } } }, { op: 'addPrefab', name: 'enemy2', base: 'enemy' }], ai);
  await p.lock(['@enemy.Script.params.angle'], keeper, '角度は決定');
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Script.params.angle', value: 30 }], ai), /🔒|ロック/);
  await p.apply([{ op: 'set', path: '@enemy.Script.params.time', value: 3 }], ai);
  // 派生の1つをロックしても、元のほかの値の変更は届く
  await p.apply([{ op: 'set', path: '@enemy2.Script.params.time', value: 4 }], ai);
  await p.lock(['@enemy2.Script.params.time'], keeper);
  await p.unlock(['@enemy.Script.params.angle'], keeper);
  await p.apply([{ op: 'set', path: '@enemy.Script.params.angle', value: 100 }], ai);
  assert.equal(p.newGame().world.spawn('enemy2').c.Script.params.angle, 100);
  // コードで形の名前を変えた（読み込んだコードは同じ処理の中では読み直せないので、登録を差し替えて同じ形に）: 値は残り、ages check が知らせる
  const q = await Project.load(dir);
  const d = q.registry.scriptParams.get('sweep')!;
  q.registry.scriptParams.delete('sweep');
  q.registry.scriptParams.set('sweep2', { ...d, name: 'sweep2' });
  assert.deepEqual(q.docs.prefabs.get('enemy')!.components.Script.params, { angle: 100, time: 3 }, '値は消えない');
  const errs = q.validate().join('\n');
  assert.match(errs, /Script\.script="sweep": 調整値の形（defineParams）がありません.*sweep2.*angle, time は残してあります/);
});
