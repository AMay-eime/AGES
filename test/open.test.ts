// エディタを開く: ポートを選ぶ・同じプロジェクトなら今のを開く・ブラウザの命令・ダブルクリックの起動用
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserCommand, choosePort, findAppBrowser, sameDir, shouldOpen, whoIs } from '../src/editor/open.ts';
import { LAUNCHER_MAC, LAUNCHER_MARK, LAUNCHER_WIN, launcherFiles, writeLaunchers } from '../src/project/launchers.ts';
import { freePort, waitFor } from '../src/cli/shot.ts';
import { cmdInit } from '../src/cli/ages.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));

test('ポートを選ぶ: 空いていればそこ・同じプロジェクトのエディタなら今のを使う・ほかなら2つ先', async () => {
  const used = new Map<number, string | null>([[5170, '/p/other'], [5172, null], [5174, '/p/mine']]);
  const opts = { isFree: async (p: number) => !used.has(p) && !used.has(p - 1), whoIs: async (p: number) => used.get(p) ?? null };
  assert.deepEqual(await choosePort('/p/mine', opts), { port: 5174, running: true });
  assert.deepEqual(await choosePort('/p/new', opts), { port: 5176, running: false });
  assert.deepEqual(await choosePort('/p/new', { ...opts, start: 6000 }), { port: 6000, running: false });
  await assert.rejects(choosePort('/p/x', { start: 5170, tries: 2, ...opts }), /使えるポートが見つかりません/);
  assert.ok(sameDir('C:\\Games\\My', 'c:\\games\\my\\', 'win32'));
  assert.ok(!sameDir('/a/My', '/a/my', 'linux'));
});

test('ブラウザで開くか・開く命令: Windows は Chrome か Edge のアプリの窓', () => {
  assert.equal(shouldOpen([], {}), true, 'ダブルクリックでも、AI が起動しても開く');
  assert.equal(shouldOpen(['--no-open'], {}), false);
  assert.equal(shouldOpen([], { CI: 'true' }), false);
  assert.equal(shouldOpen([], { AGES_NO_OPEN: '1' }), false);
  assert.equal(shouldOpen(['--open'], { CI: 'true' }), true);
  const url = 'http://localhost:5170';
  assert.deepEqual(browserCommand(url, 'win32', 'C:\\Edge\\msedge.exe'), { cmd: 'C:\\Edge\\msedge.exe', args: [`--app=${url}`] });
  assert.deepEqual(browserCommand(url, 'win32', null), { cmd: 'cmd', args: ['/c', 'start', '""', url], verbatim: true });
  assert.deepEqual(browserCommand(url, 'darwin'), { cmd: 'open', args: [url] });
  assert.deepEqual(browserCommand(url, 'linux'), { cmd: 'xdg-open', args: [url] });
  // Chrome があれば Chrome、なければ Edge
  const env = { LOCALAPPDATA: 'L', PROGRAMFILES: 'P', 'PROGRAMFILES(X86)': 'X' };
  assert.equal(findAppBrowser(env, (f) => f.includes('msedge')), join('L', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  assert.equal(findAppBrowser(env, () => true), join('L', 'Google', 'Chrome', 'Application', 'chrome.exe'));
  assert.equal(findAppBrowser(env, () => false), null);
});

test('ダブルクリックの起動用: Windows は CRLF で UTF-8 に切り替えてから・Node がなければ案内・印の行が残っていれば作り直す', async () => {
  const f = launcherFiles('ages.mjs editor');
  const win = f[LAUNCHER_WIN], mac = f[LAUNCHER_MAC];
  assert.ok(win.split('\r\n').length > 10 && !/[^\r]\n/.test(win), 'CRLF だけ');
  const lines = win.split('\r\n');
  assert.equal(lines[1], 'chcp 65001 >nul', '日本語の行より先に UTF-8 に');
  assert.ok(lines.slice(0, 2).every((l) => /^[\x20-\x7e]*$/.test(l)));
  assert.ok(lines.includes('node ages.mjs editor'));
  assert.match(win, /where node[\s\S]*nodejs\.org/);
  assert.ok(mac.startsWith('#!/bin/sh\n') && !mac.includes('\r'));
  assert.match(mac, /^node ages\.mjs editor \|\| read -r _$/m);

  const dir = await mkdtemp(join(tmpdir(), 'ages-launch-'));
  assert.deepEqual(await writeLaunchers(dir, 'ages.mjs editor'), [LAUNCHER_WIN, LAUNCHER_MAC]);
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, LAUNCHER_MAC))).mode & 0o111, 0o111, 'mac の起動用は実行できる');
  assert.deepEqual(await writeLaunchers(dir, 'ages.mjs editor'), [], '同じなら書かない');
  assert.deepEqual(await writeLaunchers(dir, '"../AGES/src/editor/server.ts" .'), [LAUNCHER_WIN, LAUNCHER_MAC], '起動の仕方が変われば作り直す');
  // 印の行を消したもの（手で直したもの）は残す
  const mine = (await readFile(join(dir, LAUNCHER_WIN), 'utf8')).split('\r\n').filter((l) => !l.includes(LAUNCHER_MARK)).join('\r\n') + 'rem mine\r\n';
  await writeFile(join(dir, LAUNCHER_WIN), mine);
  assert.deepEqual(await writeLaunchers(dir, 'ages.mjs editor'), [LAUNCHER_MAC]);
  assert.equal(await readFile(join(dir, LAUNCHER_WIN), 'utf8'), mine);
  await chmod(join(dir, LAUNCHER_MAC), 0o644);
  await rm(dir, { recursive: true, force: true });
});

test('ages init: ダブルクリックの起動用を作る（本体の場所を指す）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-init-'));
  const out = await cmdInit(join(dir, 'game'), 'game');
  assert.match(out, new RegExp(`^  ${LAUNCHER_WIN}$`, 'm'));
  const win = await readFile(join(dir, 'game', LAUNCHER_WIN), 'utf8');
  assert.match(win, /^node ".+\/src\/editor\/server\.ts" \.\r$/m);
  assert.match(await readFile(join(dir, 'game', '.gitattributes'), 'utf8'), /^\*\.cmd text eol=crlf$/m);
  // 型チェックの設定も作る（tsc -p tsconfig.json。本体と追加パッケージの場所を指す）。版だけ同梱にすると .ages/engine を指す
  assert.match(out, /^ {2}tsconfig\.json$/m);
  const ts = JSON.parse(await readFile(join(dir, 'game', 'tsconfig.json'), 'utf8'));
  assert.match(ts.compilerOptions.paths.ages[0], /\/src\/index\.ts$/);
  assert.match(ts.compilerOptions.paths['ages/*'][0], /\/src\/packages\/\*\/index\.ts$/);
  const { cmdPin } = await import('../src/cli/ages.ts');
  await rm(join(dir, 'game', 'tsconfig.json'));
  assert.match(await cmdPin(join(dir, 'game'), undefined, 'a'.repeat(40)), /tsconfig\.json（型チェック/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'game', 'tsconfig.json'), 'utf8')).compilerOptions.paths.ages, ['./.ages/engine/src/index.ts']);
  await rm(dir, { recursive: true, force: true });
});

test('エディタのサーバー: どのプロジェクトか（/api/who）を答える。--no-open なら開かない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-who-'));
  await cmdInit(join(dir, 'g'), 'g');
  const port = await freePort();
  const lock = await freePort();
  const server = spawn(process.execPath, [new URL('../src/editor/server.ts', import.meta.url).pathname, join(dir, 'g'), '--port', String(port), '--lock-port', String(lock), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout!.on('data', (d) => { out += d; });
  try {
    const who = await waitFor('editor', 20_000, async () => (await whoIs(port)) ?? undefined);
    assert.ok(sameDir(who, join(dir, 'g')));
    await waitFor('message', 5000, async () => (/止めるには Ctrl\+C/.test(out) ? true : undefined));
    assert.doesNotMatch(out, /ブラウザで開きます/);
    // 同じプロジェクトなら、新しく起動せずに今のを使う
    assert.deepEqual(await choosePort(join(dir, 'g'), { start: port, tries: 1 }), { port, running: true });
  } finally {
    server.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test('本体を横に置く形の起動用: 本体が見つからなければ、直し方を出して止まる（cmd の括弧の中に半角の括弧を書かない）', () => {
  const f = launcherFiles('"../AGES/src/editor/server.ts" .', '../AGES/src/editor/server.ts');
  const win = f[LAUNCHER_WIN].split('\r\n');
  const at = win.indexOf('if not exist "..\\AGES\\src\\editor\\server.ts" (');
  assert.ok(at > 0 && at < win.indexOf('node "../AGES/src/editor/server.ts" .'), '起動の前に確かめる');
  const block = win.slice(at + 1, win.indexOf(')', at));
  assert.ok(block.some((l) => l.includes('AGES 本体が見つかりません')) && block.some((l) => l.includes('ages pin')));
  assert.ok(block.every((l) => !/[()]/.test(l)), '半角の括弧があると、そこで if の括弧が閉じてしまう');
  assert.match(f[LAUNCHER_MAC], /if \[ ! -f "\.\.\/AGES\/src\/editor\/server\.ts" \]; then\n {2}echo "AGES 本体が見つかりません/);
  // 版だけ同梱の形（ages.mjs）には要らない
  assert.doesNotMatch(launcherFiles('ages.mjs editor')[LAUNCHER_WIN], /if not exist/);
});

test('ages init（命令）: 本体の版が GitHub にもあれば版だけ同梱の形に。なければ本体を今の場所から指す形で、その旨を言う', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { engineOnRemote } = await import('../src/project/version.ts');
  // リモートの枝に含まれているかを、通信せずに見る
  const repo = await mkdtemp(join(tmpdir(), 'ages-repo-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'a');
  assert.equal(engineOnRemote(repo), false);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal(engineOnRemote(repo), true);
  assert.equal(engineOnRemote(join(repo, 'nope')), false);

  const dir = join(await mkdtemp(join(tmpdir(), 'ages-init-')), 'g');
  const cli = new URL('../bin/ages.js', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [cli, 'init', dir, '--name', 'g', '--no-pin', '--template', 'none'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /AGES 本体を今の場所から指す形です。.*ages pin/);
  assert.equal(existsSync(join(dir, 'ages.mjs')), false);
  assert.match(await readFile(join(dir, LAUNCHER_WIN), 'utf8'), /if not exist ".*src\\editor\\server\.ts" \(/);
  // 既定: この本体が GitHub にもある版なら ages.mjs ができ、起動用は ages.mjs editor
  const dir2 = join(await mkdtemp(join(tmpdir(), 'ages-init-')), 'g');
  const r2 = spawnSync(process.execPath, [cli, 'init', dir2, '--name', 'g', '--template', 'none'], { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(existsSync(join(dir2, 'ages.mjs')), engineOnRemote());
  if (engineOnRemote()) assert.match(await readFile(join(dir2, LAUNCHER_WIN), 'utf8'), /^node ages\.mjs editor\r$/m);
});
