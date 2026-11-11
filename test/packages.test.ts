// 追加パッケージ（ages.project.json の packages。例 3d）: 入れたプロジェクトでだけ、部品・手順・地図の行が出る。
// 入れていないプロジェクト（2D）には何も足さない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdCheck, cmdMap, cmdSchema } = await import('../src/cli/ages.ts');
const { Project } = await import('../src/project/project.ts');
const { exportProject } = await import('../src/project/export.ts');
const { checkExport } = await import('../src/cli/export-check.ts');
const { Registry } = await import('../src/core/registry.ts');
const { defineComponent, defineSystem, definePackage } = await import('../src/index.ts');
const { findChrome } = await import('../src/cli/shot.ts');

async function shooter(packages?: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-pkg-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  if (packages) {
    const f = join(dir, 'ages.project.json');
    await writeFile(f, JSON.stringify({ ...JSON.parse(await readFile(f, 'utf8')), packages }, null, 2) + '\n');
  }
  return dir;
}

test('入れていないプロジェクト: 地図・手順・登録簿に何も足さない。入れていない項目を引くと入れ方を言う', async () => {
  const dir = await shooter();
  assert.doesNotMatch(await cmdMap(dir), /package/);
  const guide = await cmdSchema(dir, ['guide']);
  assert.doesNotMatch(guide, /^ {2}3d:/m);
  assert.match(guide, /^ {2}packages: 追加パッケージ/m);
  await assert.rejects(cmdSchema(dir, ['guide:3d']), /追加パッケージ 3d を入れると引けます（ages\.project\.json の packages に "3d"/);
  assert.deepEqual((await Project.load(dir)).registry.packages, []);
});

test('packages に 3d: 地図に目次・手順を引ける・ゲームのコードから ages/3d を import できる・check が通る', async () => {
  const dir = await shooter(['3d']);
  await appendFile(join(dir, 'game', 'index.ts'), "\nimport pkg3d from 'ages/3d';\nexport const usesPackage = pkg3d.name;\n");
  assert.match(await cmdMap(dir), /^## package 3d: .*\n- 3D の.* → `3d`$/m);
  assert.match(await cmdSchema(dir, ['guide']), /^ {2}3d: 3D の/m);
  assert.match(await cmdSchema(dir, ['guide:3d']), /^## 3d: 3D の[^\n]*\n- /);
  assert.match(await cmdCheck(dir), /^ok/);
  assert.deepEqual((await Project.load(dir)).registry.packages.map((p) => p.name), ['3d']);
});

test('知らない名前・packages に書かずに import: 直し方つきのエラー', async () => {
  await assert.rejects(Project.load(await shooter(['physics'])), /追加パッケージ physics はありません（ages\.project\.json の packages。使えるのは 3d）/);
  const dir = await shooter();
  await appendFile(join(dir, 'game', 'index.ts'), "\nimport pkg3d from 'ages/3d';\nexport const usesPackage = pkg3d.name;\n");
  assert.match(await cmdCheck(dir), /game\/index\.ts: 'ages\/3d' を使うには、ages\.project\.json の packages に "3d" を足します/);
});

test('登録簿: パッケージの部品は標準と同じ扱い（ゲームで同じ名前は作れない）。システムはゲームの後・標準の前', () => {
  const Body = defineComponent({ name: 'Body3', desc: '試し', fields: {} });
  const pk = definePackage({ name: 'x', desc: '試し', components: [Body], systems: [defineSystem({ name: 'pkSys', desc: '試し', reads: ['Body3'], update() {} })] });
  const game = { components: [], systems: [defineSystem({ name: 'gameSys', desc: '試し', reads: ['Body3'], update() {} })] };
  const r = Registry.from(game, [], [pk]);
  assert.equal(r.fromPackage.get('Body3'), 'x');
  const names = r.systems.map((s) => s.name);
  assert.deepEqual(names.slice(0, 2), ['gameSys', 'pkSys']);
  assert.ok(names.length > 2, '標準のシステムはその後');
  assert.throws(() => Registry.from({ components: [Body], systems: [] }, [], [pk]), /コンポーネント Body3 は追加パッケージ x で用意されています/);
  assert.throws(() => Registry.from({ components: [], systems: [defineSystem({ name: 'pkSys', desc: '', update() {} })] }, [], [pk]), /システム pkSys は追加パッケージ x にあります/);
  assert.throws(() => Registry.from(game, []), /未定義のコンポーネント Body3/, '入れていなければ部品はない');
});

test('書き出し: 入れているパッケージだけを写す。入れたものは書き出した先でも動く', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const plain = await shooter();
  await exportProject(await Project.load(plain));
  assert.equal(existsSync(join(plain, 'dist', 'web', 'engine', 'packages', '3d')), false, '入れていなければ写さない');
  assert.doesNotMatch(await readFile(join(plain, 'dist', 'web', 'index.html'), 'utf8'), /ages\/3d/);

  const dir = await shooter(['3d']);
  await appendFile(join(dir, 'game', 'index.ts'), "\nimport pkg3d from 'ages/3d';\nexport const usesPackage = pkg3d.name;\n");
  const r = await exportProject(await Project.load(dir));
  assert.deepEqual(r.notes.filter((n) => n.startsWith('⚠')), []);
  assert.ok(existsSync(join(dir, 'dist', 'web', 'engine', 'packages', '3d', 'index.js')));
  assert.match(await readFile(join(dir, 'dist', 'web', 'index.html'), 'utf8'), /"ages\/3d": "\.\/engine\/packages\/3d\/index\.js"/);
  const c = await checkExport(join(dir, 'dist', 'web'), 60);
  assert.deepEqual([c.ok, c.error], [true, '']);
});

test('エディタ: 入れているパッケージを読み込む（ゲームのコードの ages/3d も通る）', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const { spawn } = await import('node:child_process');
  const { Cdp, freePort, kill, waitFor } = await import('../src/cli/shot.ts');
  const dir = await shooter(['3d']);
  await appendFile(join(dir, 'game', 'index.ts'), "\nimport pkg3d from 'ages/3d';\nexport const usesPackage = pkg3d.name;\n");
  const port = await freePort(), lock = await freePort();
  const ed = spawn(process.execPath, [new URL('../src/editor/server.ts', import.meta.url).pathname, dir, '--port', String(port), '--lock-port', String(lock), '--no-open'], { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
  const profile = await mkdtemp(join(tmpdir(), 'ages-pkg-chrome-'));
  let b: ReturnType<typeof spawn> | undefined;
  try {
    await waitFor('editor', 20_000, async () => (await fetch(`http://127.0.0.1:${port}/api/who`).then((r) => r.ok).catch(() => false)) || undefined);
    b = spawn(findChrome()!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1200,800', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    b.stderr!.on('data', (d) => { err += d; });
    const ws = await waitFor<string>('chrome', 20_000, async () => /DevTools listening on (ws:\/\/\S+)/.exec(err)?.[1]);
    const cdp = await Cdp.open(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const ev = async (expression: string) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = []; addEventListener('error', (e) => __errs.push(e.message)); addEventListener('unhandledrejection', (e) => __errs.push(String(e.reason)));` }, sessionId);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=ja` }, sessionId);
    await waitFor('editor page', 20_000, async () => ((await ev(`!!(window.ages && window.ages.registry)`)) ? true : undefined));
    assert.equal(await ev(`ages.registry.packages.map((p) => p.name).join()`), '3d');
    assert.equal(await ev('JSON.stringify(__errs)'), '[]');
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
  } finally {
    if (b) kill(b);
    kill(ed);
    await rm(dir, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
});
