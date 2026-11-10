// 入れ子の目次（とても大きなプロジェクトの地図）の木
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, commonDir, fileKeys, findNode, isNode, leaves, rangeOf, summarize, topLine, treePage, type TreeItem } from '../src/project/map-tree.ts';

const it = (name: string, keys: string[] = []): TreeItem => ({ name, keys, line: `@${name} 行` });

test('木: 1つだけのまとめは葉に戻す・まとめと同じ名前の葉はその先頭へ・中がまとめ1つだけなら下の鍵に', () => {
  const t = buildTree([it('coin'), it('bgm'), it('bgm_battle', ['bgm']), it('bgm_title', ['bgm']), it('se_a_1', ['se', 'se_a']), it('se_a_2', ['se', 'se_a']), it('solo_x', ['solo'])]);
  assert.equal(t.n, 7);
  assert.deepEqual(t.entries.map((e) => (isNode(e) ? `${e.key}/${e.n}` : e.name)), ['coin', 'bgm/3', 'se_a/2', 'solo_x']);
  const bgm = findNode(t, ['bgm']);
  assert.ok(bgm && isNode(bgm));
  assert.deepEqual(leaves(bgm).map((x) => x.name), ['bgm', 'bgm_battle', 'bgm_title'], '同じ名前の葉が先頭');
  // 途中を省いても、木の中で1つだけの鍵なら引ける。葉も名前で引ける
  assert.equal((findNode(t, ['se_a']) as { key: string } | undefined)?.key, 'se_a');
  assert.equal(findNode(t, ['se']), undefined, 'se の中は se_a だけなので、鍵は se_a（地図に出る鍵で引く）');
  assert.equal((findNode(t, ['bgm_title']) as TreeItem).line, '@bgm_title 行');
  assert.equal(findNode(t, ['nothing']), undefined);
});

test('木の1行: 収まれば名前を全部、収まらなければまとめと数。それでも長ければ葉は数だけ。連番は 最初〜最後', () => {
  const many = [...Array(30)].map((_, i) => it(`enemy_wave_${i}`, ['enemy', 'enemy_wave']));
  const t = buildTree([it('player'), ...many, it('boss_a', ['boss']), it('boss_b', ['boss'])]);
  assert.equal(topLine(t, 300), 'player  enemy_wave/(30)  boss/(2)');
  const small = buildTree([it('a'), it('b'), it('c_1', ['c']), it('c_2', ['c'])]);
  assert.equal(topLine(small, 300), 'a b c_1 c_2', '短ければ名前を全部');
  // 長いときは葉を数に（まとめだけを残す）
  const singles = [...Array(40)].map((_, i) => it(`thing${String.fromCharCode(97 + (i % 26))}${i}`));
  const mixed = buildTree([...singles, it('x_1', ['x']), it('x_2', ['x'])]);
  assert.equal(summarize(mixed, 60), 'x/(2)  ほか名前40個');
  const wide = buildTree([...singles, ...[...Array(10)].map((_, i) => it(`g${i}_1`, [`g${i}`])), ...[...Array(10)].map((_, i) => it(`g${i}_2`, [`g${i}`]))]);
  assert.equal(summarize(wide, 60), 'g0/(2)  g1/(2)  g2/(2)  g3/(2)  g4/(2)  ほかまとめ5・名前40個');
  assert.equal(rangeOf(['star2', 'star4', 'star0', 'star1', 'star3']), 'star0〜star4');
  assert.equal(rangeOf(['star2', 'star10', 'star0', 'star1', 'star3']), null, '抜けがあれば並べる');
  assert.equal(rangeOf(['star1', 'moon2', 'star3', 'star4', 'star5']), null);
  assert.equal(topLine(buildTree(many.map((m) => ({ ...m, keys: [] }))), 50), 'enemy_wave_0〜enemy_wave_29');
});

test('まとめの1枚: 収まれば葉の行を全部（下のまとめは見出し）、収まらなければ下のまとめを1行ずつ', () => {
  const t = buildTree([it('a'), it('b_1', ['b']), it('b_2', ['b']), it('c_1', ['c', 'c_x']), it('c_2', ['c', 'c_y']), it('c_3', ['c', 'c_y'])]);
  assert.deepEqual(treePage(t, 4000), ['@a 行', '### b（2）', '@b_1 行', '@b_2 行', '### c（3）', '@c_1 行', '### c/c_y（2）', '@c_2 行', '@c_3 行']);
  assert.deepEqual(treePage(t, 40), ['@a 行', 'b/ 2個: b_1 b_2', 'c/ 3個: c_1 c_2 c_3']);
});

test('ファイルの場所の鍵: 共通のフォルダを除き、フォルダ・ファイル名の頭・ファイル名', () => {
  const files = ['game/components.ts', 'game/weapons/homing.ts', 'game/story-map.ts'];
  const root = commonDir(files);
  assert.equal(root, 'game/');
  assert.deepEqual(fileKeys('game/weapons/homing.ts', root), ['weapons', 'homing']);
  assert.deepEqual(fileKeys('game/story-map.ts', root), ['story', 'story-map']);
  assert.deepEqual(fileKeys('game/components.ts', root), ['components']);
  assert.deepEqual(fileKeys('editor/sub/bg.ext.ts', 'editor/', false), ['sub']);
  assert.equal(commonDir(['a.ts', 'b/c.ts']), '');
});
