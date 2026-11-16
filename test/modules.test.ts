// 機能ごとのモジュール（game/名前/）: 入口 index.ts・仕様 SPEC.md。ほかの機能の中身を直接 import したら ages check で知らせる。
// 地図には機能ごとに1行（🔒 は全部ロックされた機能。中を読まず仕様と入口だけ読む）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdInit, cmdCheck, cmdMap, cmdRun } = await import('../src/cli/ages.ts');
const { Project } = await import('../src/project/project.ts');

const human = { who: 'yamamoto', kind: 'human' as const, win: 'project' };

async function project(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-mod-')), 'g');
  await cmdInit(dir, 'g', 'none');
  await mkdir(join(dir, 'game/shop'), { recursive: true });
  await mkdir(join(dir, 'game/hud'), { recursive: true });
  await writeFile(join(dir, 'game/shop/price.ts'), `export const price = (base: number) => base * 2;\n`);
  await writeFile(join(dir, 'game/shop/index.ts'), `import { defineSystem } from 'ages';
import { price } from './price.ts';
export { price };
export const shop = defineSystem({ name: 'shop', desc: '買い物', reads: [], writes: [], update(ctx) { if (ctx.frame === 1) ctx.emit('shop.buy', { cost: price(5) }); } });
`);
  await writeFile(join(dir, 'game/shop/SPEC.md'), `# ショップ: お金で品物を買う\n- 出す出来事: shop.buy { cost }\n`);
  await writeFile(join(dir, 'game/hud/index.ts'), `import { defineSystem } from 'ages';
import { price } from '../shop/price.ts';
import { shop } from '../shop/index.ts';
export const hud = defineSystem({ name: 'hud', desc: '表示', reads: [], writes: [], update() { void price; void shop; } });
`);
  await writeFile(join(dir, 'game/index.ts'), `import type { GameModule } from 'ages';
import { shop } from './shop/index.ts';
import { hud } from './hud/index.ts';
export const components: GameModule['components'] = [];
export const systems: GameModule['systems'] = [shop, hud];
`);
  return dir;
}

/** EDITOR-PLAN.md で仕様駆動を選んだ（ages.project.json の modules） */
async function chooseModules(dir: string, mode: 'spec' | 'auto') {
  const f = join(dir, 'ages.project.json');
  const c = JSON.parse(await readFile(f, 'utf8'));
  await writeFile(f, JSON.stringify({ ...c, modules: mode }, null, 2));
}

test('ages check: ほかの機能の中身を直接 import したら知らせる（入口からはよい）。仕様のない機能も。modules を選んだときだけ', async () => {
  const dir = await project();
  assert.doesNotMatch(await cmdCheck(dir), /⚠ .*機能/, '選んでいなければ何も言わない（強制しない）');
  await chooseModules(dir, 'auto');
  const out = await cmdCheck(dir);
  assert.match(out, /^ok/, '知らせるだけで、止めない');
  assert.match(out, /⚠ game\/hud\/index\.ts: 機能 shop の中身（game\/shop\/price\.ts）を直接 import しています。入口 game\/shop\/index\.ts から使う/);
  assert.doesNotMatch(out, /game\/index\.ts: 機能/, 'game/ 直下（共有）から入口を使うのはよい');
  assert.match(out, /⚠ 機能 hud に仕様 game\/hud\/SPEC\.md がありません/);
  assert.doesNotMatch(out, /機能 shop に仕様/);
  assert.match(await cmdRun(dir, { frames: '2', log: 'shop.buy' }), /shop\.buy \{"cost":10\}/);
});

test('地図: 機能ごとに1行（仕様の最初の行・🔒）', async () => {
  const dir = await project();
  let map = await cmdMap(dir);
  assert.match(map, /## 機能（game\/名前\/。入口 index\.ts・仕様 SPEC\.md。🔒 の機能は中を読まず SPEC\.md と入口だけ読む/);
  assert.match(map, /\nhud 1ファイル 仕様なし\n/);
  assert.match(map, /\nshop 2ファイル: ショップ: お金で品物を買う\n/);
  const p = await Project.load(dir);
  await p.lock(['file:game/shop/index.ts'], human);
  assert.match(await cmdMap(dir), /\nshop 🔒1\/2 2ファイル: /);
  await p.lock(['file:game/shop/price.ts'], human);
  map = await cmdMap(dir);
  assert.match(map, /\nshop 🔒 2ファイル: ショップ/);
});

test('フォルダごとのロック（dir:game/名前）: 中の書き換え・足す・消す（SPEC.md も）で止める。AI は戻せる、受け入れるのはロックマネージャー。guard も断る', async () => {
  const dir = await project();
  let p = await Project.load(dir);
  await assert.rejects(p.lock(['dir:game/shop'], { who: 'ai', kind: 'ai', win: 'cli' }), /人だけ/);
  await assert.rejects(p.lock(['dir:game/nope'], human), /フォルダ game\/nope はありません/);
  await p.lock(['dir:game/shop/'], human, 'ショップ');
  assert.ok((await p.lockCandidates('dir:game')).includes('dir:game/hud'));
  assert.match(await cmdMap(dir), /\nshop 🔒 2ファイル/);
  assert.match(await cmdCheck(dir), /^ok/);
  const { cmdGuard, cmdLockRestore } = await import('../src/cli/ages.ts');
  const hook = (f: string) => cmdGuard(dir, JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(dir, f) } }));
  assert.equal((await hook('game/shop/new.ts')).code, 2, '足すのも断る');
  assert.match((await hook('game/shop/SPEC.md')).message, /フォルダ game\/shop\/ は人がロックしています（ショップ）/);
  assert.equal((await hook('game/hud/index.ts')).code, 0);
  // 仕様を書き換え・ファイルを足す
  await appendFile(join(dir, 'game/shop/SPEC.md'), '- 値引きもする\n');
  await writeFile(join(dir, 'game/shop/discount.ts'), 'export const x = 1;\n');
  assert.match(await cmdCheck(dir), /error: 🔒 ロックしたコード game\/shop\/ が書き換えられています/);
  await assert.rejects(cmdRun(dir, { frames: '2' }), /game\/shop\/ が書き換えられているので/);
  p = await Project.load(dir);
  assert.match(p.lockReport.join('\n'), /フォルダ game\/shop\/ の中が変わっています（game\/shop\/SPEC\.md を書き換えた・game\/shop\/discount\.ts を足した）/);
  assert.equal((await p.describe('dir:game/shop')).tampered, true);
  // AI が戻す: 書き換えは戻り、足したファイルは消える
  await cmdLockRestore(dir, 'game/shop/');
  assert.doesNotMatch(await readFile(join(dir, 'game/shop/SPEC.md'), 'utf8'), /値引き/);
  await assert.rejects(readFile(join(dir, 'game/shop/discount.ts')));
  assert.match(await cmdCheck(dir), /^ok/);
  // 人が確かめて受け入れる
  await writeFile(join(dir, 'game/shop/discount.ts'), 'export const x = 1;\n');
  p = await Project.load(dir);
  await assert.rejects(p.acceptLockedCode('dir:game/shop', human), /ロックマネージャーでだけ/);
  await p.acceptLockedCode('dir:game/shop', { who: 'yamamoto', kind: 'human', win: 'lock-manager' });
  assert.match(await cmdCheck(dir), /^ok/);
  assert.match(await cmdMap(dir), /\nshop 🔒 3ファイル/);
});
