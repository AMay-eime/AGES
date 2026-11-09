// シーンの編集操作（複製・削除・ずらす・プレハブにする）の op。エディタのキーと右クリックのメニューが使う
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateOps, freshId, nudgeOps, prefabOps, removeOps } from '../src/editor/edit-ops.ts';
import type { SceneDoc } from '../src/core/docs.ts';

const scene: SceneDoc = {
  name: 'main',
  entities: [
    { id: 'ship', name: 'Ship', tags: ['player'], components: { Transform: { x: 10, y: 20, sx: 2 }, Sprite: { image: 'a.png' } } },
    { id: 'ship_2', name: 'Ship', components: { Transform: { x: 0, y: 0 } } },
    { id: 'menu', name: 'Menu', components: { UI: { x: 4, y: 4 }, Layout: {} } },
    { id: 'item', name: 'Item', components: { UI: { parent: 'menu' } } },
    { id: 'hp', name: 'HP', components: { UI: { x: 1, y: 2 } } },
  ],
};

test('複製: 空いている ID で、少しずらして作る', () => {
  assert.equal(freshId('ship', new Set(['ship', 'ship_2'])), 'ship_3');
  const r = duplicateOps(scene, ['ship', 'hp'], 8);
  assert.deepEqual(r.ids, ['ship_3', 'hp_2']);
  assert.deepEqual(r.ops[0], { op: 'addEntity', scene: 'main', entity: { id: 'ship_3', name: 'Ship', tags: ['player'], components: { Transform: { x: 18, y: 28, sx: 2 }, Sprite: { image: 'a.png' } } } });
  assert.deepEqual((r.ops[1] as { entity: { components: unknown } }).entity.components, { UI: { x: 9, y: 10 } });
  assert.deepEqual(removeOps('main', ['ship']), [{ op: 'removeEntity', scene: 'main', id: 'ship' }]);
});

test('ずらす: Transform か UI の x・y。Layout で並べている子は動かさない', () => {
  assert.deepEqual(nudgeOps(scene, ['ship', 'item', 'hp'], 16, 0), [
    { op: 'set', path: 'main#ship.Transform.x', value: 26 }, { op: 'set', path: 'main#ship.Transform.y', value: 20 },
    { op: 'set', path: 'main#hp.UI.x', value: 17 }, { op: 'set', path: 'main#hp.UI.y', value: 2 },
  ]);
});

test('プレハブにする: 位置を除いた部品とタグで addPrefab', () => {
  assert.deepEqual(prefabOps(scene.entities[0], 'ship'), [{ op: 'addPrefab', name: 'ship', components: { Transform: { sx: 2 }, Sprite: { image: 'a.png' } }, tags: ['player'] }]);
});
