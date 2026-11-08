import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { readLog } from '../src/project/oplog.ts';
import { InputPlayback, keysToEvents } from '../src/core/input.ts';

// ロックの封印の鍵と控えを、テスト用の一時フォルダに置く（使用者のフォルダを汚さない）
process.env.AGES_HOME = await mkdtemp(join(tmpdir(), 'ages-home-'));

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

const F = 'main#spawner.Spawner.formation';

test('行列: セル単位で変更でき、範囲外・型違い・形の崩れはヒント付きで拒否される', async () => {
  const p = await Project.load(await fresh());
  const r = await p.apply([{ op: 'setCells', path: F, cells: [[0, 0, 1], [1, 7, 1]] }], ai);
  assert.deepEqual(r.changes.map((c) => c.path), [`${F}[0,0]`, `${F}[1,7]`]);
  await assert.rejects(p.apply([{ op: 'setCells', path: F, cells: [[0, 8, 1]] }], ai), /範囲外/);
  await assert.rejects(p.apply([{ op: 'setCells', path: F, cells: [[0, 0, 2]] }], ai), /最大値 1/);
  await assert.rejects(p.apply([{ op: 'set', path: F, value: [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0]] }], ai), /列にそろえて/);
  await assert.rejects(p.apply([{ op: 'set', path: F, value: [[0, 1]] }], ai), /8 列が必要/);
  await assert.rejects(p.apply([{ op: 'setCells', path: 'main#spawner.Spawner.interval', cells: [[0, 0, 1]] }], ai), /行列ではありません/);
});

test('行列: ロックするとAIはセル単位でも変えられない。人のセル編集はロックの値に反映される', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.lock([F], human);
  await assert.rejects(p.apply([{ op: 'setCells', path: F, cells: [[0, 0, 1]] }], ai, { force: true }), /ロックされた値/);
  await p.apply([{ op: 'setCells', path: F, cells: [[0, 0, 1]] }], human);
  const again = await Project.load(dir);
  assert.equal(again.lockReport.length, 0);
  assert.equal((again.docs.scenes.get('main')!.entities[1].components.Spawner.formation as number[][])[0][0], 1);
});

test('行列: 人がセルを変えると行列全体に★が付き、AIは確認なしに変えられない', async () => {
  const p = await Project.load(await fresh());
  await p.apply([{ op: 'setCells', path: F, cells: [[2, 2, 1]] }], human);
  await assert.rejects(p.apply([{ op: 'setCells', path: F, cells: [[3, 3, 1]] }], ai), /人が調整した値/);
});

test('ages init: 手順書とエディタ計画書の入ったプロジェクトができ、そのまま読み込める', async () => {
  const { cmdInit, planWarning } = await import('../src/cli/ages.ts');
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-init-')), 'newgame');
  const out = await cmdInit(dir, 'newgame');
  assert.match(out, /EDITOR-PLAN\.md/);
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'EDITOR-PLAN.md', '.gitignore', '.gitattributes', '.mcp.json', 'ages.project.json', 'game/index.ts', 'scenes/main.scene.json']) {
    await readFile(join(dir, f), 'utf8');
  }
  assert.match(await readFile(join(dir, 'AGENTS.md'), 'utf8'), /ゲームの企画を受けたら/);
  const p = await Project.load(dir);
  assert.deepEqual(p.validate(), []);
  assert.match(await planWarning(dir), /まだ合意されていません/);
  const plan = join(dir, 'EDITOR-PLAN.md');
  await writeFile(plan, (await readFile(plan, 'utf8')).replace('- [ ] 使用者がこの計画を確認した', '- [x] 使用者がこの計画を確認した'));
  assert.equal(await planWarning(dir), '');
  await assert.rejects(cmdInit(dir), /すでに/);
});

test('エディタ計画: 「AIにおまかせ」でも合意として扱う', async () => {
  const { cmdInit, planWarning } = await import('../src/cli/ages.ts');
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-omakase-')), 'g');
  await cmdInit(dir, 'g');
  const plan = join(dir, 'EDITOR-PLAN.md');
  assert.match(await planWarning(dir), /おまかせか/);
  await writeFile(plan, (await readFile(plan, 'utf8')).replace('- [ ] 使用者がAIにおまかせした', '- [x] 使用者がAIにおまかせした'));
  assert.equal(await planWarning(dir), '');
});


test('封印: AIがロックの記録から項目を消しても、ロックは外れず、AIの編集は止まる', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.lock(['main#player.Player.speed'], human);
  // AIがロックの記録を直接書き換えて、ロックを消し、値も書き換える
  await writeFile(join(dir, '.ages', 'locks.json'), '{}\n');
  const file = p.scenePath('main');
  await writeFile(file, (await readFile(file, 'utf8')).replace('"speed": 4.5', '"speed": 9'));
  const again = await Project.load(dir);
  assert.equal(again.integrity.ok, false);
  assert.match(again.lockReport.join(), /一致しません/);
  assert.match(await readFile(file, 'utf8'), /"speed": 4.5/);  // 控えのロックで元に戻る
  await assert.rejects(again.apply([{ op: 'set', path: 'main#player.Player.fireInterval', value: 3 }], ai, { force: true }), /AIからの編集を止めています/);
  assert.deepEqual(again.lockDiff().removed, ['main#player.Player.speed']);
});

test('封印: 人が「前の状態に戻す」とロックが戻り、AIの編集も再開できる', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.lock(['main#player.Player.speed'], human);
  await writeFile(join(dir, '.ages', 'locks.json'), '{}\n');
  const again = await Project.load(dir);
  await assert.rejects(again.lock(['main#player.Player.fireInterval'], human), /確認が必要/);
  await again.restoreLocks(human);
  assert.equal(again.integrity.ok, true);
  assert.ok((await again.effectiveLocks())['main#player.Player.speed']);
  await again.apply([{ op: 'set', path: 'main#player.Player.fireInterval', value: 3 }], ai);
});

test('封印: Gitで取り込んだロックの変更は、人が承認するまでAIを止める', async () => {
  const dir = await fresh();
  // 別の人の端末で封印されたロックの記録だけが届いた状態（この端末の封印がない）
  await mkdir(join(dir, '.ages'), { recursive: true });
  await writeFile(join(dir, '.ages', 'locks.json'), JSON.stringify({ 'main#player.Player.speed': { who: 'teammate', t: '2026-11-08T00:00:00Z', value: 4.5 } }));
  const p = await Project.load(dir);
  assert.equal(p.integrity.ok, false);
  assert.match(p.integrity.reason!, /まだ人がロックの記録を確認していません/);
  await assert.rejects(p.apply([{ op: 'set', path: 'main#spawner.Spawner.interval', value: 30 }], ai), /止めています/);
  await p.approveLocks(human);
  assert.equal(p.integrity.ok, true);
  await assert.rejects(p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 6 }], ai, { force: true }), /ロックされた値/);
  await p.apply([{ op: 'set', path: 'main#spawner.Spawner.interval', value: 30 }], ai);
});
