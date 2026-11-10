// 階層の木: UI の親子
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uiParents } from '../src/editor/tree.ts';

test('階層の木: UI.parent で親子。プレハブの値も見る・シーンにない親と自分は親なし・UI でない物は木に入らない', () => {
  const ents = [
    { id: 'panel', name: 'panel', components: { UI: { parent: null } } },
    { id: 'item', name: 'item', components: { UI: { parent: 'panel' } } },
    { id: 'fromPrefab', name: 'fromPrefab', prefab: 'btn', components: {} },
    { id: 'lost', name: 'lost', components: { UI: { parent: 'nowhere' } } },
    { id: 'self', name: 'self', components: { UI: { parent: 'self' } } },
    { id: 'star', name: 'star', components: { Transform: { x: 1, y: 2 } } },
  ];
  const prefabs = { btn: { name: 'btn', components: { UI: { parent: 'item' } } } };
  const { parent, hasUI } = uiParents(ents as never, prefabs as never);
  assert.deepEqual([...parent], [['item', 'panel'], ['fromPrefab', 'item']]);
  assert.deepEqual([...hasUI].sort(), ['fromPrefab', 'item', 'lost', 'panel', 'self']);
});

test('階層の木: 連番の名前で子のない兄弟が5つ以上なら1行にまとめる（最初の物の場所・数の順）', async () => {
  const { groupNumbered } = await import('../src/editor/tree.ts');
  const e = (id: string) => ({ id, name: id, components: {} });
  const list = [e('bg'), ...[10, 2, 0, 1, 3].map((n) => e(`star${n}`)), e('title'), e('row1'), e('row2'), e('star4')];
  const out = groupNumbered(list as never, (id) => id === 'star4');
  assert.deepEqual(out.map((x) => ('members' in x ? `${x.prefix}[${x.members.map((m) => m.id).join(',')}]` : x.id)),
    ['bg', 'star[star0,star1,star2,star3,star10]', 'title', 'row1', 'row2', 'star4']);
  // 4つ以下はまとめない
  assert.equal(groupNumbered([e('a1'), e('a2'), e('a3'), e('a4')] as never, () => false).length, 4);
});
