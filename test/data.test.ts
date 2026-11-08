// 段階2-4: データの型（リスト・構造体・どれか1つ）と表
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { checkAt, defaultOf, typeOf, type Field } from '../src/core/schema.ts';
import { cellsToRows, importOps, parseDelimited } from '../src/core/csv.ts';
import { cmdGet, cmdTable } from '../src/cli/ages.ts';
import { readTouched } from '../src/project/oplog.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const human = { who: 'yamamoto', kind: 'human' as const, win: 'inspector' };
const keeper = { who: 'yamamoto', kind: 'human' as const, win: 'lock-manager' };
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };

const STEP: Field = {
  type: 'oneOf', variants: {
    move: { fields: { dx: { type: 'number', default: 0, min: -10, max: 10 }, dy: { type: 'number', default: 0 } } },
    wait: { fields: { frames: { type: 'int', default: 30, min: 1, max: 600 } } },
    shoot: { fields: { pattern: { type: 'enum', options: ['single', 'spread'], default: 'single' }, at: { type: 'struct', fields: { x: { type: 'number', default: 0 }, y: { type: 'number', default: 0 } } } } },
  },
};

/** サンプルに、命令の列（リストの中にどれか1つ）を持つコンポーネントを足した写し */
async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  const file = join(dir, 'game/components.ts');
  await writeFile(file, (await readFile(file, 'utf8')) + `
export const Script = defineComponent({ name: 'Script', desc: '命令の列', fields: {
  steps: { type: 'list', max: 8, of: ${JSON.stringify(STEP)}, default: [{ kind: 'move', dx: 1, dy: 0 }] },
  home: { type: 'struct', fields: { x: { type: 'number', default: 0 }, y: { type: 'number', default: 0 } } },
} });
`);
  const p = await Project.load(dir);
  await p.apply([{ op: 'addComponent', target: 'main#player', component: 'Script' }], ai);
  return dir;
}

test('型: 中まで検証し、問題のある場所を正確に示す。既定値は中から作る', () => {
  const list: Field = { type: 'list', of: STEP, max: 2 };
  assert.equal(checkAt('S.steps', list, [{ kind: 'move', dx: 1 }, { kind: 'wait', frames: 999 }]), 'S.steps[1](wait).frames=999 は最大値 600 を超えています（範囲 1..600）');
  assert.match(checkAt('S.steps', list, [{ kind: 'mvoe' }])!, /S\.steps\[0\]\.kind="mvoe" は move \| wait \| shoot.*もしかして: move/);
  assert.match(checkAt('S.steps', list, [{ kind: 'wait', dx: 1 }])!, /\(wait\) に dx という項目はありません.*ある項目: frames/);
  assert.match(checkAt('S.steps', list, [{ kind: 'wait' }, { kind: 'wait' }, { kind: 'wait' }])!, /2 個までです/);
  assert.deepEqual(defaultOf(STEP), { kind: 'move', dx: 0, dy: 0 });
  assert.deepEqual(defaultOf({ type: 'struct', fields: { a: { type: 'int', default: 3 }, b: { type: 'list', of: { type: 'string', default: '' } } } }), { a: 3, b: [] });
  assert.equal(typeOf(list), 'list<oneOf<move{dx:num -10..10,dy:num}|wait{frames:int 1..600}|shoot{pattern:single|spread,at:{x:num,y:num}}>>(0..2個)');
});

test('入れ子の住所: 中の値を読み書きし、リストに足す・消す・動かす', async () => {
  const p = await Project.load(await fresh());
  const at = 'main#player.Script.steps';
  await p.apply([{ op: 'insert', path: at, value: { kind: 'wait', frames: 10 } }, { op: 'insert', path: at, index: 0 }], ai);
  assert.deepEqual(p.docs.scenes.get('main')!.entities.find((e) => e.id === 'player')!.components.Script.steps, [{ kind: 'move', dx: 0, dy: 0 }, { kind: 'move', dx: 1, dy: 0 }, { kind: 'wait', frames: 10 }]);
  await p.apply([{ op: 'set', path: `${at}[2].frames`, value: 20 }, { op: 'set', path: `${at}[0]`, value: { kind: 'shoot', pattern: 'spread' } }, { op: 'set', path: `${at}[0].at.y`, value: 5 }], ai);
  await p.apply([{ op: 'moveItem', path: `${at}[0]`, to: 2 }, { op: 'removeItem', path: `${at}[0]` }], ai);
  const steps = (await Project.load(p.dir)).docs.scenes.get('main')!.entities.find((e) => e.id === 'player')!.components.Script.steps;
  assert.deepEqual(steps, [{ kind: 'wait', frames: 20 }, { kind: 'shoot', pattern: 'spread', at: { y: 5 } }]);
  // ない場所・範囲外・型の違いは、場所を示して止める（何も変えない）
  await assert.rejects(p.apply([{ op: 'set', path: `${at}[5].frames`, value: 1 }], ai), /steps\[5\] は範囲外です（2 個/);
  await assert.rejects(p.apply([{ op: 'set', path: `${at}[0].frame`, value: 1 }], ai), /（種類 wait）に frame という項目はありません。もしかして: frames/);
  await assert.rejects(p.apply([{ op: 'set', path: 'main#player.Script.home.z', value: 1 }], ai), /home に z という項目はありません/);
  await assert.rejects(p.apply(Array.from({ length: 7 }, () => ({ op: 'insert' as const, path: at })), ai), /8 個までです/);
  assert.match(await cmdGet(p.dir, [`${at}[1].at`]), /steps\[1\]\.at = \{"x":0,"y":5\}/);
});

test('リストのロックと★: リスト全体でロックする（中の要素の番号ではロックできない）。人が中を変えるとリスト全体に★', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  const at = 'main#player.Script.steps';
  await assert.rejects(p.lock([`${at}[0].dx`], keeper), /リストの中の要素はロックできません/);
  await p.lock(['main#player.Script.home.x'], keeper); // 構造体の中はロックできる
  await assert.rejects(p.apply([{ op: 'set', path: 'main#player.Script.home.x', value: 3 }], ai), /🔒/);
  await assert.rejects(p.apply([{ op: 'set', path: 'main#player.Script.home', value: { x: 3, y: 1 } }], ai), /🔒/, '中にロックのある値を、まるごと変えることもできない');
  await p.lock([at], keeper);
  await assert.rejects(p.apply([{ op: 'set', path: `${at}[0].dx`, value: 5 }], ai, { force: true }), /🔒/);
  await assert.rejects(p.apply([{ op: 'insert', path: at }], ai, { force: true }), /🔒/);
  await p.unlock([at], keeper);
  await p.apply([{ op: 'set', path: `${at}[0].dx`, value: 2 }], human);
  assert.ok((await readTouched(dir))[at], '人が中を変えると、リスト全体に★');
  await assert.rejects(p.apply([{ op: 'set', path: `${at}[0].dy`, value: 1 }], ai), /人が調整した値/);
});

test('表: 行の追加・ID の変更（指している値も直る）・削除は参照があれば止まる・ゲームのコードから型付きで読む', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'addRow', table: 'enemies', row: { id: 'boss', hp: 50, score: 5000 }, index: 0 }], ai);
  assert.deepEqual(p.docs.tables.get('enemies')!.rows.map((r) => r.id), ['boss', 'basic', 'fast', 'tough']);
  const r = await p.apply([{ op: 'renameRow', table: 'enemies', id: 'fast', to: 'quick' }], ai);
  assert.ok(r.changes.some((c) => c.path === 'main#spawner.Spawner.kinds' && c.auto));
  assert.deepEqual(p.docs.scenes.get('main')!.entities.find((e) => e.id === 'spawner')!.components.Spawner.kinds, ['basic', 'basic', 'quick', 'basic', 'tough']);
  await assert.rejects(p.apply([{ op: 'removeRow', table: 'enemies', id: 'tough' }], ai), /kinds\[4\]="tough": 表 enemies にその行はありません/);
  await assert.rejects(p.apply([{ op: 'set', path: '$enemies.boss.hp', value: 500 }], ai), /最大値 100/);
  await assert.rejects(p.apply([{ op: 'addRow', table: 'enemies', row: { id: 'x', hpp: 1 } as never }], ai), /列 hpp はありません。もしかして: hp/);
  await p.apply([{ op: 'moveRow', table: 'enemies', id: 'boss', to: 3 }], ai);
  const view = p.newGame().ctx.table('enemies');
  assert.deepEqual(view.ids, ['basic', 'quick', 'tough', 'boss']);
  assert.equal(view.get('boss').speed, 1, '省いた列は既定値');
  assert.throws(() => view.get('bos'), /行 "bos" はありません。もしかして: boss/);
  assert.throws(() => { (view.get('boss') as unknown as { hp: number }).hp = 1; }, TypeError, 'ゲームのコードからは変えられない');
  // ファイルは1行1行
  assert.match(await readFile(join(dir, 'data/enemies.table.json'), 'utf8'), /\n {4}\{"id":"boss","hp":50,"score":5000\}\n/);
});

test('表のロック: セルごと。AIは ID の変更も削除もできない。人が ID を変えるとロックも付け替わる。直接の書き換えは戻る', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.lock(['$enemies.tough.hp'], keeper);
  await assert.rejects(p.apply([{ op: 'set', path: '$enemies.tough.hp', value: 9 }], ai, { force: true }), /🔒/);
  await assert.rejects(p.apply([{ op: 'renameRow', table: 'enemies', id: 'tough', to: 'heavy' }], ai, { force: true }), /🔒/);
  await p.apply([{ op: 'set', path: '$enemies.tough.speed', value: 0.8 }], ai);
  await p.apply([{ op: 'renameRow', table: 'enemies', id: 'tough', to: 'heavy' }], human);
  assert.deepEqual(Object.keys(await p.effectiveLocks()), ['$enemies.heavy.hp']);
  const file = join(dir, 'data/enemies.table.json');
  await writeFile(file, (await readFile(file, 'utf8')).replace('"id":"heavy","hp":5', '"id":"heavy","hp":99'));
  const q = await Project.load(dir);
  assert.ok(q.lockReport.some((l) => l.includes('$enemies.heavy.hp')));
  assert.equal(q.docs.tables.get('enemies')!.rows.find((r) => r.id === 'heavy')!.hp, 5);
});

test('表計算ソフトとの行き来: CSV を読み、変わったセルだけの操作にする。書き出して読み戻すと変化なし', async () => {
  assert.deepEqual(parseDelimited('id,name\r\na,"x, ""y"""\nb,"2行\n目"\n'), [['id', 'name'], ['a', 'x, "y"'], ['b', '2行\n目']]);
  const dir = await fresh();
  const p = await Project.load(dir);
  const def = p.registry.table('enemies');
  const next = cellsToRows(def, parseDelimited('id\thp\tspeed\ttint\nbasic\t3\t\t\nfast\t1\t1.6\t#ffd0a0\nnew\t4\t2\t\n'));
  const ops = importOps(def, p.docs.tables.get('enemies')!.rows, next);
  assert.deepEqual(ops.map((o) => o.op === 'set' ? `${o.op} ${o.path}=${o.value}` : `${o.op} ${'id' in o ? o.id : o.op === 'addRow' ? o.row.id : ''}`),
    ['removeRow tough', 'set $enemies.basic.hp=3', 'set $enemies.fast.score=100', 'set $enemies.fast.frame=18', 'addRow new']);
  assert.throws(() => cellsToRows(def, parseDelimited('id,hp\na,abc')), /\$enemies\.a\.hp は数値が必要です/);
  const csv = join(dir, 'e.csv');
  assert.match(await cmdTable(dir, 'enemies', { export: csv }), /3行/);
  assert.equal(await cmdTable(dir, 'enemies', { import: csv }), '変更なし（読み込んだ内容と同じです）');
  await writeFile(csv, (await readFile(csv, 'utf8')).replace('basic,2', 'basic,4'));
  assert.match(await cmdTable(dir, 'enemies', { import: csv }), /値の変更 1/);
  assert.match(await cmdTable(dir, 'enemies', { cols: 'hp' }), /^\$enemies 3行 — 敵の種類\nid\thp\nbasic\t4\nfast\t1\ntough\t5$/m);
});

test('検証: 形のない表・ない行を指す値', async () => {
  const dir = await fresh();
  await writeFile(join(dir, 'data/weapons.table.json'), '{"name":"weapons","rows":[]}');
  const p = await Project.load(dir);
  assert.ok(p.validate().some((e) => /表 weapons の形がゲームのコードにありません/.test(e)));
});
