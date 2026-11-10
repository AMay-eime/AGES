// GitHub との自動の取り込み（エディタ）: 上流が変わったかを聞き、手元に何もなければ早送りで取り込み、手元に変更があれば
// コミット → 取り込み → プッシュ を人が選んだときだけ行う
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { dirtyCount, pushAndPull, remoteState, type Git } from '../src/editor/gitsync.ts';

const runIn = (cwd: string): Git => (args) => new Promise((ok) => {
  execFile('git', args, { cwd }, (err, stdout, stderr) => ok({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: (stdout + stderr).trim() }));
});
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

let hasGit = true;
try { execFileSync('git', ['--version']); } catch { hasGit = false; }

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ages-sync-'));
  const remote = join(dir, 'remote.git');
  sh(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  for (const who of ['me', 'other']) {
    sh(dir, 'clone', '-q', remote, who);
    sh(join(dir, who), 'config', 'user.name', who);
    sh(join(dir, who), 'config', 'user.email', `${who}@local`);
  }
  await writeFile(join(dir, 'me', 'a.txt'), '1\n');
  sh(join(dir, 'me'), 'add', '-A');
  sh(join(dir, 'me'), 'commit', '-qm', 'first');
  sh(join(dir, 'me'), 'push', '-q', '-u', 'origin', 'main');
  sh(join(dir, 'other'), 'pull', '-q', 'origin', 'main');
  sh(join(dir, 'other'), 'branch', '-q', '--set-upstream-to=origin/main', 'main');
  return { dir, me: join(dir, 'me'), other: join(dir, 'other') };
}

async function otherPushes(other: string, file: string, text: string) {
  await writeFile(join(other, file), text);
  sh(other, 'add', '-A');
  sh(other, 'commit', '-qm', `other: ${file}`);
  sh(other, 'push', '-q');
}

test('上流が変わったかを聞く: 変わっていなければ取ってこない。変われば取ってきて、取り込んでいない・プッシュしていない・コミットしていないを数える', { skip: !hasGit && 'git がない' }, async () => {
  const { dir, me, other } = await setup();
  try {
    const git = runIn(me);
    const s0 = await remoteState(git);
    assert.equal(s0.upstream, 'origin/main');
    assert.deepEqual([s0.behind, s0.ahead, s0.dirty], [0, 0, 0]);
    await otherPushes(other, 'b.txt', 'x\n');
    const s1 = await remoteState(git);
    assert.equal(s1.behind, 1);
    assert.equal(s1.remoteHead, sh(other, 'rev-parse', 'HEAD').trim());
    // 手元に何もなければ早送りで取り込める
    assert.equal((await git(['pull', '--ff-only', '--no-edit'])).code, 0);
    assert.equal(await readFile(join(me, 'b.txt'), 'utf8'), 'x\n');
    assert.equal((await remoteState(git)).behind, 0);
    // 手元の変更を数える
    await writeFile(join(me, 'a.txt'), '2\n');
    assert.equal(await dirtyCount(git), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('上流のない枝では使えない（upstream なし）', { skip: !hasGit && 'git がない' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-sync-'));
  try {
    sh(dir, 'init', '-q', '-b', 'main');
    const s = await remoteState(runIn(dir));
    assert.equal(s.upstream, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('プッシュしてから取り込む: コミット → 取り込み → プッシュ。食い違えばプッシュせずに止める', { skip: !hasGit && 'git がない' }, async () => {
  const { dir, me, other } = await setup();
  try {
    const git = runIn(me);
    await otherPushes(other, 'b.txt', 'x\n');
    await writeFile(join(me, 'c.txt'), 'mine\n');
    const s = await remoteState(git);
    assert.deepEqual([s.behind, s.dirty], [1, 1]);
    const r = await pushAndPull(git, 'AGES: 1件の編集');
    assert.equal(r.ok, true, r.out);
    assert.equal(r.step, 'done');
    sh(other, 'pull', '-q');
    assert.equal(await readFile(join(other, 'c.txt'), 'utf8'), 'mine\n');
    assert.deepEqual([(await remoteState(git)).behind, (await remoteState(git)).ahead], [0, 0]);
    // 同じ行を両方で変えると食い違う → プッシュしない
    await otherPushes(other, 'a.txt', 'theirs\n');
    await writeFile(join(me, 'a.txt'), 'mine\n');
    await remoteState(git);
    const before = sh(other, 'ls-remote', 'origin', 'refs/heads/main');
    const c = await pushAndPull(git, 'AGES: 1件の編集');
    assert.equal(c.ok, false);
    assert.equal(c.conflict, true);
    assert.equal(c.step, 'pull');
    assert.equal(sh(other, 'ls-remote', 'origin', 'refs/heads/main'), before, 'プッシュしていない');
    // 取り込みはやめて元に戻す（食い違いの印を残さない）。手元の変更はコミット済み
    assert.equal(await readFile(join(me, 'a.txt'), 'utf8'), 'mine\n');
    assert.equal(sh(me, 'status', '--porcelain'), '');
    assert.equal((await remoteState(git)).ahead, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
