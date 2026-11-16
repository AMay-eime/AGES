// コードとふるまいのロック: 書き換えを見つけて止める（人が受け入れる・戻す）。決まった操作の結果を答えとしてロックし、変わったら止める。
// Claude Code の hooks から、ロックしたファイルへの書き込みを断る（ages guard）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { Project } = await import('../src/project/project.ts');
const { cmdCheck, cmdRun, cmdExport, cmdBehave, cmdLockRestore, cmdGuard, cmdPatch, runBehave } = await import('../src/cli/ages.ts');
const { specHash } = await import('../src/project/behave.ts');

const keeper = { who: 'yamamoto', kind: 'human' as const, win: 'lock-manager' };
const human = { who: 'yamamoto', kind: 'human' as const, win: 'inspector' };
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-codelock-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

test('コードのロック: 書き換えられたら check・run・export を止める。AI は戻せる、受け入れるのはロックマネージャーだけ', async () => {
  const dir = await fresh();
  let p = await Project.load(dir);
  await assert.rejects(p.lock(['file:game/systems.ts'], ai), /人だけ/);
  await assert.rejects(p.lock(['file:game/nope.ts'], human), /ありません.*コード/);
  await p.lock(['file:game/systems.ts'], human, 'ショップの動き');
  assert.match(await cmdCheck(dir), /^ok/);
  // AI がファイルを直接書き換える
  await appendFile(join(dir, 'game/systems.ts'), '\n// 書き換え\n');
  assert.match(await cmdCheck(dir), /error: 🔒 ロックしたコード game\/systems\.ts が書き換えられています/);
  await assert.rejects(cmdRun(dir, { frames: '10' }), /ロックしたコード game\/systems\.ts が書き換えられているので、ages run で動かすことはできません/);
  await assert.rejects(cmdExport(dir, { out: join(dir, 'dist-x') }), /書き出しできません/);
  p = await Project.load(dir);
  assert.equal((await p.describe('file:game/systems.ts')).kind, 'code');
  assert.equal((await p.describe('file:game/systems.ts')).tampered, true);
  // AI は戻せる
  assert.match(await cmdLockRestore(dir, 'game/systems.ts'), /ロックしたときの中身に戻しました/);
  assert.ok(!(await readFile(join(dir, 'game/systems.ts'), 'utf8')).includes('// 書き換え'));
  assert.match(await cmdCheck(dir), /^ok/);
  // 人が確かめて受け入れる（ロックマネージャーからだけ）
  await appendFile(join(dir, 'game/systems.ts'), '\n// 人が認めた変更\n');
  p = await Project.load(dir);
  await assert.rejects(p.acceptLockedCode('game/systems.ts', human), /ロックマネージャーでだけ/);
  await assert.rejects(p.acceptLockedCode('game/systems.ts', ai), /ロックマネージャーでだけ/);
  await p.acceptLockedCode('game/systems.ts', keeper);
  assert.match(await cmdCheck(dir), /^ok/);
  assert.ok((await readFile(join(dir, 'game/systems.ts'), 'utf8')).includes('// 人が認めた変更'));
  assert.ok((await p.lockCandidates('file:game')).includes('file:game/index.ts'), 'ロックの候補にコードも');
});

test('ふるまいのロック: 決まった操作の結果を答えとして撮り、値やコードの変更で動きが変わったら check・書き出しで止める', async () => {
  const dir = await fresh();
  await mkdir(join(dir, 'checks'));
  await writeFile(join(dir, 'checks/move-left.behave.json'), JSON.stringify({ desc: '左へ動きながら撃つ', keys: '0-10:@fire+@move_x=-1', frames: 10, watch: ['player.Transform.x'], log: ['*'] }, null, 2));
  assert.match(await cmdBehave(dir), /・move-left（左へ動きながら撃つ） ロックなし: player\.Transform\.x=\d+/);
  let p = await Project.load(dir);
  await assert.rejects(p.lock(['behave:move-left'], keeper), /撮ってロック/, '答えはロックマネージャーが再生して撮る');
  const r = await runBehave(p, 'move-left');
  await p.lock(['behave:move-left'], keeper, '自機の動き', { 'behave:move-left': { spec: specHash(r.text), result: r.result } });
  assert.match(await cmdBehave(dir), /🔒✓ move-left/);
  assert.match(await cmdCheck(dir), /^ok/);
  // 値を変えると動きが変わる（ロックしていない値でも、ふるまいで見つかる）
  const speed = (await (await import('../src/cli/ages.ts')).cmdGet(dir, ['main#player.Player.speed'])).trim().replace(/^.* = /, '');
  await cmdPatch(dir, [{ op: 'set', path: 'main#player.Player.speed', value: Number(speed) * 2 }], false);
  assert.match(await cmdCheck(dir), /error: 🔒 ふるまい move-left（左へ動きながら撃つ）が変わりました: player\.Transform\.x: \d+ → \d+/);
  assert.match(await cmdBehave(dir, 'move-left'), /✗ move-left.*答えと違う/);
  await assert.rejects(cmdExport(dir, { out: join(dir, 'dist-x') }), /ロックしたふるまいが変わっているので、書き出せません/);
  await cmdPatch(dir, [{ op: 'set', path: 'main#player.Player.speed', value: Number(speed) }], false);
  assert.match(await cmdCheck(dir), /^ok/);
  // 決まりを書き換えても見つかる
  await writeFile(join(dir, 'checks/move-left.behave.json'), JSON.stringify({ desc: '左へ動きながら撃つ', keys: '0-10:@fire+@move_x=-1', frames: 8, watch: ['player.Transform.x'] }));
  assert.match(await cmdCheck(dir), /ふるまい move-left の決まり（checks\/move-left\.behave\.json）が、ロックした後に書き換えられています/);
  p = await Project.load(dir);
  assert.match(String((await p.describe('behave:move-left')).problem), /書き換えられています/);
  assert.ok((await p.lockCandidates('behave')).includes('behave:move-left'));
});

test('ages guard（Claude Code の hooks）: ロックしたコード・ふるまいの決まり・ロックの記録への書き込みを断る', async () => {
  const dir = await fresh();
  await mkdir(join(dir, 'checks'));
  await writeFile(join(dir, 'checks/a.behave.json'), JSON.stringify({ desc: 'a', frames: 5, watch: ['player.Transform.x'] }));
  const p = await Project.load(dir);
  await p.lock(['file:game/systems.ts'], human, 'ショップ');
  const r = await runBehave(p, 'a');
  await p.lock(['behave:a'], keeper, undefined, { 'behave:a': { spec: specHash(r.text), result: r.result } });
  const hook = (file: string) => cmdGuard(dir, JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(dir, file) } }));
  assert.equal((await hook('game/systems.ts')).code, 2);
  assert.match((await hook('game/systems.ts')).message, /人がロックしています（ショップ）/);
  assert.equal((await hook('checks/a.behave.json')).code, 2);
  assert.equal((await hook('.ages/locks.json')).code, 2);
  assert.equal((await hook('game/index.ts')).code, 0);
  assert.equal((await cmdGuard(dir, JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'game/systems.ts' } }))).code, 2, '相対の場所も');
  assert.equal((await cmdGuard(dir, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }))).code, 0);
  assert.equal((await cmdGuard(dir, 'not json')).code, 0);
});
