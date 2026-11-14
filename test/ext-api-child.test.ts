// エディタ拡張の api.get: 子の住所（@プレハブ/子・シーン#置いた物/子）は子の値を返す（issue #138）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdInit, cmdPatch } = await import('../src/cli/ages.ts');
const { Project } = await import('../src/project/project.ts');
const { makeApi } = await import('../src/editor/extensions.ts');
const { resolveScene } = await import('../src/core/variant.ts');

test('api.get は子の値（派生・置いた物ごとの値も重ねる）。部品まるごとは既定値で埋める', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-extget-')), 'g');
  await cmdInit(dir, 'g', 'none');
  await cmdPatch(dir, [
    { op: 'addPrefab', name: 'ship', components: { Transform: { x: 0 }, Shape: { kind: 'rect', w: 40, h: 20, color: '#88ccff' } }, children: [{ name: 'gun_l', components: { Transform: { x: -12, y: 4 }, Shape: { kind: 'rect', w: 6, h: 12, color: '#ff8888' } } }, { name: 'core', components: {} }] },
    { op: 'addPrefab', name: 'ship_v', base: 'ship' },
    { op: 'set', path: '@ship_v/gun_l.Shape.color', value: '#00ff00' },
    { op: 'addEntity', scene: 'main', entity: { id: 'boss', name: 'boss', prefab: 'ship', components: {} } },
    { op: 'set', path: 'main#boss/gun_l.Transform.x', value: -40 },
  ] as any, false);
  const p = await Project.load(dir);
  const prefabs = Object.fromEntries(p.docs.prefabs), scenes = Object.fromEntries(p.docs.scenes);
  const app = { state: { prefabs, scenes }, registry: p.registry, sceneView: (n: string) => scenes[n] && resolveScene(p.docs.prefabs, scenes[n]) } as any;
  const api = makeApi(app, 'test');
  assert.equal(api.get('@ship.Transform.x'), 0);
  assert.equal(api.get('@ship/gun_l.Transform.x'), -12);
  assert.equal(api.get('@ship/gun_l.Shape.color'), '#ff8888');
  assert.equal(api.get('@ship_v/gun_l.Shape.color'), '#00ff00', '派生の子');
  assert.equal(api.get('@ship_v/gun_l.Transform.x'), -12, '派生が受け継いだ子の値');
  assert.equal(api.get('main#boss/gun_l.Transform.x'), -40, '置いた物ごとの子の値');
  assert.equal(api.get('main#boss/gun_l.Shape.color'), '#ff8888');
  assert.equal(api.get('@ship/core.Transform.x'), 0, '書いていない位置は既定値');
  assert.equal((api.get('@ship/gun_l.Shape') as { color: string; alpha?: number }).color, '#ff8888');
  assert.ok('kind' in (api.get('@ship/gun_l.Shape') as object), '部品まるごとは既定値で埋める');
  assert.equal(api.get('@ship/nope.Transform.x'), undefined, 'ない子');
});
