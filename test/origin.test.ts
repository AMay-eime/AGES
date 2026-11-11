// アセットの出どころの記録（自作・AI 生成・素材・人に頼んだ）: 書く・一覧・未記入の ⚠・場所の変更についていく
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdInit, cmdAssets, cmdCheck, cmdPatch, cmdUndo, cmdExport } = await import('../src/cli/ages.ts');
const { originOf, setOrigin, moveOrigins, unrecorded } = await import('../src/project/origin.ts');

/** 1×1 の PNG */
const png = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('出どころの形: フォルダの記録は中のファイルに効く（近い方が勝つ）・人の記録は AI が変えられない・場所の変更についていく', () => {
  const assets = ['assets/kit/a.png', 'assets/kit/sub/b.png', 'assets/own.png', 'assets/fx.frag'].map((path) => ({ path, kind: path.endsWith('.frag') ? 'shader' : 'image', bytes: 1 })) as any[];
  const o: Record<string, any> = {};
  assert.match(setOrigin(o, assets, ['ja'], 'assets/kit', { by: 'stock', license: 'CC0', from: 'Kenney' }, 'ai').text, /^assets\/kit\/（中の 2 ファイル）: 配布・購入の素材・CC0・Kenney$/);
  assert.match(setOrigin(o, assets, ['ja'], 'assets/kit/sub/b.png', { by: 'ai' }, 'ai').text, /AI 生成。--tool で使った AI の名前も$/);
  assert.equal(originOf(o, 'assets/kit/a.png')!.key, 'assets/kit/');
  assert.equal(originOf(o, 'assets/kit/sub/b.png')!.origin.by, 'ai');
  // シェーダーはコードなので、未記入に数えない
  assert.deepEqual(unrecorded(o, assets).map((a) => a.path), ['assets/own.png']);
  // 一部だけ書き足す（ほかの欄は残る）
  setOrigin(o, assets, ['ja'], 'assets/kit/sub/b.png', { tool: 'ImageGen' }, 'ai');
  assert.deepEqual(o['assets/kit/sub/b.png'], { by: 'ai', tool: 'ImageGen', who: 'ai' });
  // 人が書いた記録は、AI は --force なしで変えられない
  setOrigin(o, assets, ['ja'], 'assets/own.png', { by: 'own' }, 'human');
  assert.throws(() => setOrigin(o, assets, ['ja'], 'assets/own.png', { by: 'ai' }, 'ai'), /★ assets\/own\.png の出どころは人が書いたものです（自作）/);
  setOrigin(o, assets, ['ja'], 'assets/own.png', { by: 'commission', from: 'A さん' }, 'ai', true);
  assert.equal(o['assets/own.png'].by, 'commission');
  // ないファイル・ない言語・知らない種類
  assert.throws(() => setOrigin(o, assets, ['ja'], 'assets/none.png', { by: 'own' }, 'ai'), /というファイル・フォルダはありません/);
  assert.throws(() => setOrigin(o, assets, ['ja'], '$text.en', { by: 'ai' }, 'ai'), /言語 en はありません/);
  assert.throws(() => setOrigin(o, assets, ['ja'], 'assets/kit', { by: 'bought' }, 'ai'), /--by は own（自作） \/ ai（AI 生成）/);
  // 場所の変更: フォルダの記録も、中のファイルの記録も
  assert.ok(moveOrigins(o, [{ from: 'assets/kit', to: 'assets/packs/kit', dir: true }]));
  assert.deepEqual(Object.keys(o).sort(), ['assets/own.png', 'assets/packs/kit/', 'assets/packs/kit/sub/b.png']);
  // 消す
  setOrigin(o, assets, ['ja'], 'assets/own.png', { by: 'none' }, 'human');
  assert.ok(!o['assets/own.png']);
});

test('ages assets --origin: 書く・一覧・check と書き出しの ⚠（止めない）・moveAsset と undo についていく', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-origin-')), 'g');
  await cmdInit(dir, 'g');
  await mkdir(join(dir, 'assets', 'kit'), { recursive: true });
  for (const f of ['kit/a.png', 'kit/b.png', 'hero.png', 'logo.png']) await writeFile(join(dir, 'assets', f), png());
  await cmdPatch(dir, [{ op: 'addEntity', scene: 'main', entity: { id: 'hero', components: { Transform: {}, Sprite: { image: 'assets/hero.png' } } } }], false);

  // 何も書いていない: check は ok のまま ⚠ を1行
  let check = await cmdCheck(dir);
  assert.match(check, /^ok/);
  assert.match(check, /^⚠ 出どころが未記入のアセット 4件/m);

  assert.match(await cmdAssets(dir, undefined, { origin: 'assets/kit', by: 'stock', license: 'CC0', from: 'Kenney https://kenney.nl' }), /^assets\/kit\/（中の 2 ファイル）: 配布・購入の素材・CC0・Kenney/);
  assert.match(await cmdAssets(dir, undefined, { origin: 'assets/hero.png', by: 'ai', tool: 'ImageGen 3' }), /^assets\/hero\.png: AI 生成・ImageGen 3$/);
  await assert.rejects(cmdAssets(dir, undefined, { origin: 'assets/hero.png' }), /書く中身がありません/);
  let list = await cmdAssets(dir, undefined, { origin: true });
  assert.match(list, /^出どころ（アセット 4件のうち未記入 1）/);
  assert.match(list, /^生成 AI を使った物: 画像 1（ストアの申告: 事前に作った AI の内容あり）$/m);
  assert.match(list, /^AI 生成:\n  assets\/hero\.png — ImageGen 3$/m);
  assert.match(list, /^配布・購入の素材:\n  assets\/kit\/ 2件 — CC0・Kenney https:\/\/kenney\.nl$/m);
  assert.match(list, /^⚠ 未記入:\n  assets\/logo\.png$/m);
  assert.match(await cmdCheck(dir), /^⚠ 出どころが未記入のアセット 1件/m);

  // 場所を変えると、記録もついていく。元に戻すと、記録も戻る
  await cmdPatch(dir, [{ op: 'moveAsset', from: 'assets/hero.png', to: 'assets/chars/hero.png' }, { op: 'moveAsset', from: 'assets/kit', to: 'assets/packs/kit' }], false);
  let saved = JSON.parse(await readFile(join(dir, 'assets.origin.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved), ['assets/chars/hero.png', 'assets/packs/kit/']);
  await cmdUndo(dir, {});
  saved = JSON.parse(await readFile(join(dir, 'assets.origin.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved), ['assets/hero.png', 'assets/kit/']);

  // 書き出し: 申告のまとめと ⚠。止まらない
  const out = await cmdExport(dir, { out: join(dir, 'dist', 'web') });
  assert.match(out, /^書き出しました/);
  assert.match(out, /出どころ: 生成 AI を使った物は 画像 1（未記入 1件）/);
  assert.match(out, /^⚠ 出どころが未記入のアセットが 1件あります/m);

  // 全部書くと ⚠ は消える
  await cmdAssets(dir, undefined, { origin: 'assets/logo.png', by: 'own' });
  check = await cmdCheck(dir);
  assert.doesNotMatch(check, /出どころ/);
});
