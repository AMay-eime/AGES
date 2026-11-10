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
