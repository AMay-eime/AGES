// エディタの Git のパネル: 失敗を知らせる（#89）・よくある失敗の説明と直す手（#90）・取り込んだ変更を操作ログに二重に書かない（#91）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explainGit, githubOwner, noreplyEmail, safeRemoteUrl } from '../src/editor/git-help.ts';
import { cmdInit, cmdPatch } from '../src/cli/ages.ts';
import { Project } from '../src/project/project.ts';
import { readLog } from '../src/project/oplog.ts';
import { freePort, waitFor } from '../src/cli/shot.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));

let hasGit = true;
try { execFileSync('git', ['--version']); } catch { hasGit = false; }
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

const GH007 = `remote: error: GH007: Your push would publish a private email address.
remote: You can make your email public or disable this protection by visiting:
remote: https://github.com/settings/emails
To https://github.com/me/game.git
 ! [remote rejected] main -> main (push declined due to email privacy restrictions)
error: failed to push some refs to 'https://github.com/me/game.git'`;

test('よくある失敗を見分ける: GH007・場所が変わった・先に進んでいる・送り先がない・ログイン・変更なし', () => {
  const a = explainGit('push', 1, GH007);
  assert.equal(a[0].level, 'bad');
  assert.deepEqual(a[0].fix, { kind: 'noreply' });
  const moved = explainGit('push', 0, 'remote: This repository moved. Please use the new location:\nremote:   https://github.com/Me/Game.git\nTo https://github.com/me/game.git\n   a..b  main -> main');
  assert.equal(moved.length, 1);
  assert.equal(moved[0].level, 'info', 'プッシュは通ったので知らせだけ');
  assert.deepEqual(moved[0].fix, { kind: 'set-url', url: 'https://github.com/Me/Game.git' });
  const behind = explainGit('push', 1, " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs\nhint: Updates were rejected because the remote contains work that you do not");
  assert.deepEqual(behind[0].fix, { kind: 'pushpull' });
  const up = explainGit('push', 128, 'fatal: The current branch dev has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin dev\n');
  assert.deepEqual(up[0].fix, { kind: 'set-upstream', branch: 'dev' });
  assert.match(explainGit('push', 128, "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/me/game.git/'")[0].title, /ログイン/);
  assert.match(explainGit('push', 128, "fatal: unable to access 'https://github.com/me/game.git/': The requested URL returned error: 403")[0].title, /ログイン|権限/);
  assert.match(explainGit('pull', 128, "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com")[0].title, /つながりません/);
  assert.deepEqual(explainGit('commit', 128, 'Author identity unknown\n\n*** Please tell me who you are.')[0].fix, { kind: 'identity' });
  const none = explainGit('commit', 1, 'On branch main\nnothing to commit, working tree clean');
  assert.equal(none.length, 1);
  assert.equal(none[0].level, 'info');
  assert.match(explainGit('push', 1, 'something unknown')[0].title, /プッシュできませんでした/);
  assert.deepEqual(explainGit('push', 0, 'Everything up-to-date'), []);
  assert.equal(githubOwner('https://github.com/AMay-eime/AGES.git'), 'AMay-eime');
  assert.equal(githubOwner('git@github.com:someone/x.git'), 'someone');
  assert.equal(noreplyEmail(123, 'me'), '123+me@users.noreply.github.com');
  assert.ok(safeRemoteUrl('https://github.com/Me/Game.git'));
  assert.ok(!safeRemoteUrl('https://github.com/x.git --upload-pack=evil'));
  assert.ok(!safeRemoteUrl('--help'));
});

test('取り込み（Git）や CLI で増えた操作ログの行の変更は、時刻が古くても外からの編集として二重に書かない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-ext-'));
  const g = join(dir, 'g');
  await cmdInit(g, 'g');
  await cmdPatch(g, [{ op: 'addEntity', scene: 'main', entity: { id: 'box', components: { Transform: { x: 2 } } } }], false);
  const p = await Project.load(g);
  await p.rememberLog();
  const file = join(g, 'scenes', 'main.scene.json');
  const setX = async (x: number) => { const d = JSON.parse(await readFile(file, 'utf8')); d.entities[0].components.Transform.x = x; await writeFile(file, JSON.stringify(d, null, 2) + '\n'); };
  // ほかの PC の CLI で変えて、ファイルと操作ログの行を取り込んだのと同じ（行の時刻は5分前）
  await setX(4);
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  const line = JSON.stringify({ t: old, who: 'ai', kind: 'ai', op: 'batch', path: 'main#box.Transform.x', win: 'cli', from: 2, to: 4 });
  await writeFile(join(g, '.ages', 'oplog.jsonl'), (await readFile(join(g, '.ages', 'oplog.jsonl'), 'utf8')) + line + '\n');
  const r = await p.externalEdit();
  assert.deepEqual(r.changes, [], '取り込んだ行にある変更は、もう記録されている');
  assert.equal((await readLog(g)).filter((e) => e.who === 'external').length, 0);
  // 操作ログにない変更（ほかのエディタで直接書いた）は、外からの編集として1回だけ書く
  await setX(7);
  const r2 = await p.externalEdit();
  assert.deepEqual(r2.changes.map((c) => [c.path, c.to]), [['main#box.Transform.x', 7]]);
  assert.equal((await readLog(g)).filter((e) => e.who === 'external').length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('Git のパネル: プッシュが断られたら ok: false と説明・noreply に直してコミットを作り直す・場所が変わった知らせ', { skip: hasGit ? false : 'git がない' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-gitp-'));
  const remote = join(dir, 'remote.git');
  sh(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(dir, 'clone', '-q', remote, 'me');
  const me = join(dir, 'me');
  sh(me, 'config', 'user.name', 'me');
  sh(me, 'config', 'user.email', 'secret@example.com');
  await cmdInit(join(me, 'g'), 'g');
  sh(me, 'add', '-A');
  sh(me, 'commit', '-qm', 'first');
  sh(me, 'push', '-q', '-u', 'origin', 'main');
  // GitHub の代わり: noreply 以外のアドレスのコミットを GH007 で断る
  const hook = join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, `#!/bin/sh
while read old new ref; do
  if git log --format=%ae "$old..$new" | grep -qv 'users.noreply.github.com'; then
    echo "error: GH007: Your push would publish a private email address." >&2
    exit 1
  fi
done
echo "This repository moved. Please use the new location:" >&2
echo "  ${remote}" >&2
exit 0
`);
  await chmod(hook, 0o755);
  // GitHub の API の代わり（ユーザーの番号）
  const api = createServer((req, res) => {
    if (req.url === '/users/me') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":4242,"login":"me"}'); return; }
    res.writeHead(404).end('{}');
  });
  const apiPort = await freePort();
  await new Promise<void>((ok) => api.listen(apiPort, ok));
  const port = await freePort(), lock = await freePort();
  const server = spawn(process.execPath, [new URL('../src/editor/server.ts', import.meta.url).pathname, join(me, 'g'), '--port', String(port), '--lock-port', String(lock), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AGES_GITHUB_API: `http://127.0.0.1:${apiPort}` } });
  const call = async (path: string, body?: unknown) => (await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
  try {
    await waitFor('editor', 20_000, async () => (await fetch(`http://127.0.0.1:${port}/api/who`).then((r) => r.ok).catch(() => false)) || undefined);
    const st = await call('/api/git/status');
    assert.deepEqual(st.identity, { name: 'me', email: 'secret@example.com' });
    await writeFile(join(me, 'g', 'notes.txt'), 'x\n');
    const c = await call('/api/git/commit', { message: 'notes' });
    assert.equal(c.ok, true);
    const nothing = await call('/api/git/commit', { message: 'again' });
    assert.equal(nothing.ok, false);
    assert.equal(nothing.help[0].level, 'info', '変更がないのは失敗として扱わない');
    // #89: 断られたら ok: false と、何が起きたか
    const push = await call('/api/git/push', {});
    assert.equal(push.ok, false);
    assert.equal(push.help[0].fix.kind, 'noreply');
    assert.match(push.help[0].title, /非公開/);
    // #90: noreply のアドレスにして、プッシュしていないコミットを作り直す
    const fix = await call('/api/git/fix', { kind: 'noreply', login: 'me' });
    assert.equal(fix.ok, true, fix.out);
    assert.equal(sh(me, 'config', 'user.email'), '4242+me@users.noreply.github.com');
    assert.equal(sh(me, 'log', '-1', '--format=%ae %ce'), '4242+me@users.noreply.github.com 4242+me@users.noreply.github.com');
    assert.equal(sh(me, 'log', '-1', '--format=%s'), 'notes', '中身と説明はそのまま');
    const again = await call('/api/git/push', {});
    assert.equal(again.ok, true, again.out);
    assert.equal(again.help[0].fix.kind, 'set-url', '通ったが、場所が変わった知らせ');
    assert.equal(again.help[0].level, 'info');
    const moved = await call('/api/git/fix', { kind: 'set-url', url: 'https://github.com/me/game.git' });
    assert.equal(moved.ok, true);
    assert.equal(sh(me, 'remote', 'get-url', 'origin'), 'https://github.com/me/game.git');
    assert.equal((await call('/api/git/fix', { kind: 'set-url', url: '--upload-pack=x' })).ok, false, '引数を壊す形は受け付けない');
  } finally {
    server.kill();
    api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Git で取り込んだ変更を、開いているエディタが操作ログに external でもう一度書かない（#91）', { skip: hasGit ? false : 'git がない' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-pull-'));
  const remote = join(dir, 'remote.git');
  sh(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(dir, 'clone', '-q', remote, 'a');
  const a = join(dir, 'a');
  for (const [k, v] of [['user.name', 'a'], ['user.email', 'a@local']]) sh(a, 'config', k, v);
  await cmdInit(join(a, 'g'), 'g');
  await cmdPatch(join(a, 'g'), [{ op: 'addEntity', scene: 'main', entity: { id: 'box', components: { Transform: { x: 2 } } } }], false);
  sh(a, 'add', '-A');
  sh(a, 'commit', '-qm', 'first');
  sh(a, 'push', '-q', '-u', 'origin', 'main');
  sh(dir, 'clone', '-q', remote, 'b');
  const b = join(dir, 'b');
  for (const [k, v] of [['user.name', 'b'], ['user.email', 'b@local']]) sh(b, 'config', k, v);
  const port = await freePort(), lock = await freePort();
  const server = spawn(process.execPath, [new URL('../src/editor/server.ts', import.meta.url).pathname, join(b, 'g'), '--port', String(port), '--lock-port', String(lock), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitFor('editor', 20_000, async () => (await fetch(`http://127.0.0.1:${port}/api/who`).then((r) => r.ok).catch(() => false)) || undefined);
    // A: CLI で値を変え、操作ログごとコミットしてプッシュ
    await cmdPatch(join(a, 'g'), [{ op: 'set', path: 'main#box.Transform.x', value: 123 }], false);
    sh(a, 'add', '-A');
    sh(a, 'commit', '-qm', 'ai: x');
    sh(a, 'push', '-q');
    // B: エディタの Git のパネルで取り込む（CLI の行の時刻は15秒より前にしておく）
    const logFile = join(b, 'g', '.ages', 'oplog.jsonl');
    await new Promise((r) => setTimeout(r, 16_000));
    const r = await (await fetch(`http://127.0.0.1:${port}/api/git/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { ok: boolean };
    assert.equal(r.ok, true);
    await new Promise((r) => setTimeout(r, 2500));
    const log = (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(log.filter((e) => e.path?.endsWith('.Transform.x') && e.who === 'ai').length, 1, '取り込んだ CLI の行');
    assert.equal(log.filter((e) => e.who === 'external').length, 0, '同じ変更を external でもう一度書かない');
  } finally {
    server.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
