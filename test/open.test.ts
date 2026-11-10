// エディタを開く: ポートを選ぶ・同じプロジェクトなら今のを開く・ブラウザの命令・ダブルクリックの起動用
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
