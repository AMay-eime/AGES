import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { readLog } from '../src/project/oplog.ts';
import { keysToEvents } from '../src/cli/ages.ts';
import { InputPlayback } from '../src/core/input.ts';

const human = { who: 'yamamoto', kind: 'human' as const, win: 'inspector' };
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

test('同じシードと入力なら毎回同じ結果になる', async () => {
  const p = await Project.load(await fresh());
  const run = () => {
    const g = p.newGame();
    const play = new InputPlayback(keysToEvents('0-600:KeyZ;100-300:ArrowLeft'));
    for (let i = 0; i < 600; i++) g.step(play.keysAt(g.frame));
    return g.hash();
  };
  assert.equal(run(), run());
});

test('範囲外の値はヒント付きで拒否され、ファイルは変わらない', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  const before = await readFile(p.scenePath('main'), 'utf8');
  await assert.rejects(p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 99 }], ai), /最大値 20/);
  assert.equal(await readFile(p.scenePath('main'), 'utf8'), before);
});

test('複数の操作は全部成功するか、何も変えないか', async () => {
  const p = await Project.load(await fresh());
  await assert.rejects(p.apply([
    { op: 'set', path: 'main#player.Player.speed', value: 5 },
    { op: 'set', path: 'main#player.Player.nope', value: 1 },
  ], ai));
  assert.equal((p.docs.scenes.get('main')!.entities[0].components.Player as { speed: number }).speed, 4.5);
});

test('人が調整した値は、AIが変えるには --force が必要', async () => {
  const p = await Project.load(await fresh());
  await p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 5 }], human);
  await assert.rejects(p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 6 }], ai), /人が調整した値/);
  await p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 6 }], ai, { force: true });
});

test('ロックした値は、AIからは --force でも変えられない', async () => {
  const p = await Project.load(await fresh());
  await p.lock(['main#player.Player.speed'], human, '手触りの核');
  await assert.rejects(p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 6 }], ai, { force: true }), /ロックされた値/);
  await assert.rejects(p.apply([{ op: 'removeComponent', target: 'main#player', component: 'Player' }], ai, { force: true }), /ロックされた値/);
  await assert.rejects(p.apply([{ op: 'removeEntity', scene: 'main', id: 'player' }], ai, { force: true }), /ロックされた値/);
});

test('ロックの設定はAIにはできない', async () => {
  const p = await Project.load(await fresh());
  await assert.rejects(p.lock(['main#player.Player.speed'], ai), /人だけ/);
});

test('ファイルを直接書き換えられても、ロックした値は次の読み込みで元に戻る', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.lock(['main#player.Player.speed'], human);
  const file = p.scenePath('main');
  await writeFile(file, (await readFile(file, 'utf8')).replace('"speed": 4.5', '"speed": 9'));
  const again = await Project.load(dir);
  assert.match(again.lockReport.join(), /戻しました/);
  assert.match(await readFile(file, 'utf8'), /"speed": 4.5/);
  const log = await readLog(dir);
  assert.equal(log.at(-1)!.op, 'lock-restore');
});

test('人がロック中の値を編集すると、ロックの値も更新される', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.lock(['main#player.Player.speed'], human);
  await p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 5.5 }], human);
  const again = await Project.load(dir);
  assert.equal(again.lockReport.length, 0);
});

test('CLIの変更をエディタが外部編集として二重に記録しない', async () => {
  const dir = await fresh();
  const editor = await Project.load(dir);
  const cli = await Project.load(dir);
  await cli.apply([{ op: 'set', path: 'main#player.Player.fireInterval', value: 4 }], ai);
  const r = await editor.externalEdit();
  assert.equal(r.changes.length, 0);
  assert.equal((await readLog(dir)).filter((e) => e.kind === 'system').length, 0);
});

test('別のエディタで書かれた変更は external として記録される', async () => {
  const dir = await fresh();
  const editor = await Project.load(dir);
  const file = editor.scenePath('main');
  await writeFile(file, (await readFile(file, 'utf8')).replace('"fireInterval": 8', '"fireInterval": 5'));
  const r = await editor.externalEdit();
  assert.deepEqual(r.changes.map((c) => c.path), ['main#player.Player.fireInterval']);
});

test('要約では値の変更とロックを分けて表示する', async () => {
  const { summarize } = await import('../src/project/oplog.ts');
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 6 }], human);
  await p.lock(['main#player.Player.speed'], human);
  const s = summarize(await readLog(dir));
  assert.match(s, /speed 4\.5→6/);
  assert.match(s, /speed 🔒ロック/);
});
