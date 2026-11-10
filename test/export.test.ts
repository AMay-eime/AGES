// 段階3: 書き出し（Web と、デスクトップ＝Tauri の元）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { Project } from '../src/project/project.ts';
import { EXPORT_MARK, exportProject, icoFromPng, importsOf, rewriteImports } from '../src/project/export.ts';
import { checkExport } from '../src/cli/export-check.ts';
import { findChrome } from '../src/cli/shot.ts';
import { cmdExport } from '../src/cli/ages.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));

async function shooter(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-exp-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  return dir;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(f)));
    else out.push(f);
  }
  return out;
}

test('import の .ts を .js に（手元の import だけ。npm の名前・文字列の中は触らない）', () => {
  const code = [
    "import { a } from './a.ts';",
    "export { b } from '../b/b.ts';",
    "import './side.ts';",
    "import { c } from 'ages';",
    "const m = await import('./lazy.ts');",
    "const s = 'from ./x.ts';",
  ].join('\n');
  const out = rewriteImports(code);
  assert.match(out, /from '\.\/a\.js'/);
  assert.match(out, /from '\.\.\/b\/b\.js'/);
  assert.match(out, /import '\.\/side\.js'/);
  assert.match(out, /from 'ages'/);
  assert.match(out, /import\('\.\/lazy\.js'\)/);
  assert.match(out, /'from \.\/x\.ts'/, '文字列の中は直さない');
  assert.deepEqual(importsOf(code).sort(), ['../b/b.ts', './a.ts', './lazy.ts', './side.ts', 'ages'].sort());
});

test('ages export: エディタを含まない Web の一式（.ts は残らず、手元の import はみな行き先がある）', async () => {
  const dir = await shooter();
  const p = await Project.load(dir);
  const r = await exportProject(p);
  assert.equal(r.web, join(dir, 'dist', 'web'));
  for (const f of ['index.html', 'project.json', 'engine/index.js', 'engine/player/main.js', EXPORT_MARK]) assert.ok(existsSync(join(r.web, f)), f);
  assert.ok(existsSync(join(r.web, p.config.game.replace(/\.ts$/, '.js'))), 'ゲームの入り口');
  const files = await walk(r.web);
  assert.ok(!files.some((f) => f.endsWith('.ts')), '.ts は残らない');
  // エディタ・CLI・MCP は入れない（editor/window-api は 'ages' が出す defineWindow などの窓口。本体からは型だけを読む）
  const tools = files.filter((f) => /[\\/]engine[\\/](editor|cli|mcp)[\\/]/.test(f)).map((f) => relative(join(r.web, 'engine'), f).split('\\').join('/'));
  assert.deepEqual(tools, ['editor/window-api.js']);
  for (const f of files.filter((f) => f.endsWith('.js'))) {
    const code = await readFile(f, 'utf8');
    for (const spec of importsOf(code)) {
      if (spec === 'ages') { assert.ok(relative(join(r.web, 'engine'), f).startsWith('..'), `本体の中で 'ages' を読まない: ${f}`); continue; }
      assert.match(spec, /^\.{1,2}\//, `npm の部品を読まない: ${spec} (${f})`);
      assert.ok(!spec.endsWith('.ts'), `${f} に .ts の import: ${spec}`);
      assert.ok(existsSync(resolve(dirname(f), spec)), `${f} の ${spec} がない`);
    }
  }
  // データとアセット
  const b = JSON.parse(await readFile(join(r.web, 'project.json'), 'utf8'));
  assert.equal(b.entry, p.config.game.replace(/^\.\//, '').replace(/\.ts$/, '.js'));
  assert.deepEqual(Object.keys(b.scenes).sort(), [...p.docs.scenes.keys()].sort());
  for (const a of p.assets) assert.ok(existsSync(join(r.web, a.path)), a.path);
  const html = await readFile(join(r.web, 'index.html'), 'utf8');
  assert.match(html, /"ages": "\.\/engine\/index\.js"/);
  assert.match(html, /src="\.\/engine\/player\/main\.js"/);
  // dist/ は Git に入れず、アセットとしても数えない
  assert.match(await readFile(join(dir, '.gitignore'), 'utf8'), /^dist\/$/m);
  const again = await Project.load(dir);
  assert.ok(!again.assets.some((a) => a.path.startsWith('dist/')), 'dist/ はアセットの一覧に出ない');
  assert.equal(again.assets.length, p.assets.length);
  // もう一度書き出しても前のものを消して作り直す（.gitignore に2回足さない）
  await writeFile(join(r.web, 'old.txt'), 'x');
  await exportProject(again);
  assert.ok(!existsSync(join(r.web, 'old.txt')));
  assert.equal((await readFile(join(dir, '.gitignore'), 'utf8')).match(/^dist\/$/gm)?.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('ages export: 書き出したものでないフォルダは消さない・ages check のエラーがあれば書き出さない', async () => {
  const dir = await shooter();
  const other = await mkdtemp(join(tmpdir(), 'ages-exp-other-'));
  await mkdir(join(other, 'web'));
  await writeFile(join(other, 'web', 'mine.txt'), '大事');
  const p = await Project.load(dir);
  await assert.rejects(exportProject(p, { out: other }), /書き出したものでないファイルがあります/);
  assert.equal(await readFile(join(other, 'web', 'mine.txt'), 'utf8'), '大事');
  // シーンを壊すと書き出さない
  const scenes = [...p.docs.scenes.keys()];
  const sceneFile = join(dir, 'scenes', `${scenes[0]}.scene.json`);
  const doc = JSON.parse(await readFile(sceneFile, 'utf8'));
  doc.entities = [...(doc.entities ?? []), { id: doc.entities?.[0]?.id ?? 'x', components: {} }, { id: doc.entities?.[0]?.id ?? 'x', components: {} }];
  await writeFile(sceneFile, JSON.stringify(doc));
  await assert.rejects(exportProject(await Project.load(dir)), /ages check のエラーを直してから/);
  await rm(dir, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });
});

test('ages export --desktop: Tauri の元は初めの1回だけ作り、直した所を上書きしない', async () => {
  const dir = await shooter();
  const p = await Project.load(dir);
  const r = await exportProject(p, { desktop: true, id: 'com.test.shooter', fullscreen: true });
  assert.equal(r.desktop, join(dir, 'dist', 'desktop'));
  const t = join(r.desktop!, 'src-tauri');
  for (const f of ['Cargo.toml', 'build.rs', 'src/main.rs', 'tauri.conf.json', 'capabilities/default.json', 'icons/icon.png', 'icons/icon.ico']) assert.ok(existsSync(join(t, f)), f);
  const conf = JSON.parse(await readFile(join(t, 'tauri.conf.json'), 'utf8'));
  assert.equal(conf.identifier, 'com.test.shooter');
  assert.equal(conf.build.frontendDist, '../../web');
  assert.equal(conf.app.withGlobalTauri, true);
  assert.equal(conf.app.windows[0].fullscreen, true);
  assert.equal(conf.app.windows[0].width, p.config.view.width);
  assert.ok(existsSync(resolve(t, conf.build.frontendDist, 'index.html')), 'Tauri が Web の書き出しを見つけられる');
  const caps = JSON.parse(await readFile(join(t, 'capabilities/default.json'), 'utf8'));
  assert.ok(caps.permissions.includes('core:window:allow-set-fullscreen'));
  assert.ok(!r.notes.some((n) => n.includes('仮の')), 'ID を決めたときは知らせない');
  // 直した所は残る（Web は作り直す）
  await writeFile(join(t, 'tauri.conf.json'), '{"mine":true}');
  const r2 = await exportProject(await Project.load(dir), { desktop: true });
  assert.equal(await readFile(join(t, 'tauri.conf.json'), 'utf8'), '{"mine":true}');
  assert.ok(r2.notes.some((n) => n.includes('もうあるので、そのままにしました')));
  assert.ok(existsSync(join(r2.web, 'index.html')));
  // ID を決めないと仮の ID を知らせる
  const dir2 = await shooter();
  const r3 = await exportProject(await Project.load(dir2), { desktop: true });
  assert.ok(r3.notes.some((n) => n.includes('仮の com.example.')));
  await rm(dir, { recursive: true, force: true });
  await rm(dir2, { recursive: true, force: true });
});

test('.ico: PNG を1枚入れた頭（Windows の exe のアイコン）', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const ico = icoFromPng(png, 192);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 1);
  assert.equal(ico.readUInt8(6), 192);
  assert.equal(ico.readUInt32LE(14), png.length);
  assert.equal(ico.readUInt32LE(18), 22);
  assert.deepEqual(ico.subarray(22), png);
  assert.equal(icoFromPng(png, 256).readUInt8(6), 0, '256 は 0 と書く');
});

test('ages export --check: 書き出したものを headless の Chrome で開き、進む・エラーなし', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = await shooter();
  const out = await cmdExport(dir, { check: true });
  assert.match(out, /^書き出しました: /m);
  assert.match(out, /^確かめました: headless の Chrome で \d+フレーム/m, out);
  // 壊れたゲームは「動きません」と知らせる
  const r = await exportProject(await Project.load(dir));
  await writeFile(join(r.web, 'project.json'), '{"entry":"nothing.js"}');
  const c = await checkExport(r.web, 30, 30_000);
  assert.equal(c.ok, false);
  assert.ok(c.error.length > 0);
  await rm(dir, { recursive: true, force: true });
});
