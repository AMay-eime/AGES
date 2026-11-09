// シーンに置いたプレハブのインスタンス: プレハブとつながり、違う値だけを書く・プレハブの変更が伝わる・ロック・戻す・つなぐ/切り離す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { cmdCheck, cmdGet, cmdMap, cmdRun } from '../src/cli/ages.ts';
import { readLog } from '../src/project/oplog.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const ai = { who: 'claude', kind: 'ai' as const, win: 'cli' };
const human = { who: 'yamamoto', kind: 'human' as const, win: 'inspector' };
const keeper = { who: 'yamamoto', kind: 'human' as const, win: 'lock-manager' };

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

const entityOf = async (dir: string, scene: string, id: string) => JSON.parse(await readFile(join(dir, 'scenes', `${scene}.scene.json`), 'utf8')).entities.find((e: { id: string }) => e.id === id);

test('プレハブのインスタンスを置くと、ファイルにはつながりと違う値だけ。動かすとプレハブと重なる', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([
    { op: 'addEntity', scene: 'main', entity: { id: 'boss', prefab: 'enemy', components: { Transform: { x: 100, y: 50 } } } },
    { op: 'set', path: 'main#boss.Health.hp', value: 9 },
  ], ai);
  assert.deepEqual(await entityOf(dir, 'main', 'boss'), { id: 'boss', name: 'boss', prefab: 'enemy', components: { Transform: { x: 100, y: 50 }, Health: { hp: 9 } } });
  const g = p.newGame();
  const e = g.world.get('boss')!;
  assert.equal(e.prefab, 'enemy');
  assert.equal(e.c.Health.hp, 9);
  assert.equal(e.c.Velocity.vy, 2, 'プレハブの値');
  assert.equal(e.c.Transform.sx, 1.25, '同じ部品の書いていない値はプレハブの値');
  assert.deepEqual(e.tags, ['enemy']);
  assert.equal(await cmdGet(dir, ['main#boss.Velocity.vy']), 'main#boss.Velocity.vy = 2');
  // プレハブと同じ値にすると、受け継ぐに戻る
  await p.apply([{ op: 'set', path: 'main#boss.Health.hp', value: 2 }], ai);
  assert.deepEqual((await entityOf(dir, 'main', 'boss')).components, { Transform: { x: 100, y: 50 } });
  // 地図・ages run
  assert.match(await cmdMap(dir), /^ {2}main#boss "boss" ←@enemy 変:Transform\.x,Transform\.y \[Transform Sprite Velocity Health Enemy Effect Collider\] tags:enemy$/m);
  assert.match(await cmdRun(dir, { frames: '2' }), /@enemy/);
  assert.match(await cmdCheck(dir), /^ok/);
});

test('プレハブを直すと、インスタンスに伝わる（変えた値はそのまま）。受け継いだ値のロックも効く', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'addEntity', scene: 'main', entity: { id: 'boss', prefab: 'enemy', components: { Health: { hp: 9 } } } }], ai);
  await p.apply([{ op: 'set', path: '@enemy.Velocity.vy', value: 5 }, { op: 'set', path: '@enemy.Health.hp', value: 3 }], human);
  const e = p.newGame().world.get('boss')!;
  assert.equal(e.c.Velocity.vy, 5);
  assert.equal(e.c.Health.hp, 9);
  assert.deepEqual((await entityOf(dir, 'main', 'boss')).components, { Health: { hp: 9 } }, 'インスタンスのファイルは変わらない');
  assert.ok((await readLog(dir)).some((x) => x.path === 'main#boss.Velocity.vy' && x.via === '@enemy' && x.to === 5), '記録には「プレハブの変更で」変わった値');
  await p.lock(['main#boss.Velocity.vy'], keeper);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Velocity.vy', value: 7 }], human), /ロックされています: main#boss\.Velocity\.vy/);
});

test('戻す・部品を外す/足す・つなぐ/切り離す・名前の変更・消せない・シーンの写し', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'addPrefab', name: 'foe', copy: 'enemy' }, { op: 'addEntity', scene: 'main', entity: { id: 'boss', prefab: 'foe', components: { Health: { hp: 9 }, Velocity: { vy: 4 } } } }], ai);
  // 戻す: 値ごと・部品ごと
  await p.apply([{ op: 'revert', path: 'main#boss.Health.hp' }, { op: 'revert', path: 'main#boss.Velocity' }], ai);
  assert.deepEqual((await entityOf(dir, 'main', 'boss')).components, {});
  // 外す・足す
  await p.apply([{ op: 'removeComponent', target: 'main#boss', component: 'Effect' }, { op: 'addComponent', target: 'main#boss', component: 'Lifetime', values: { frames: 30 } }], ai);
  const raw = await entityOf(dir, 'main', 'boss');
  assert.deepEqual(raw.remove, ['Effect']);
  assert.deepEqual(raw.components, { Lifetime: { frames: 30 } });
  assert.equal(p.newGame().world.get('boss')!.c.Effect, undefined);
  // 名前の変更でつながりも直る。使われているプレハブは消せない
  await p.apply([{ op: 'renamePrefab', name: 'foe', to: 'foe2' }], ai);
  assert.equal((await entityOf(dir, 'main', 'boss')).prefab, 'foe2');
  await assert.rejects(p.apply([{ op: 'removePrefab', name: 'foe2' }], ai), /main#boss（インスタンス）/);
  // シーンの写しでも、つながったまま
  await p.apply([{ op: 'addScene', name: 'main2', copy: 'main' }], ai);
  assert.deepEqual(await entityOf(dir, 'main2', 'boss'), { ...raw, prefab: 'foe2' });
  // 切り離すと、今の値をまるごと持つ（値は変わらない）
  const before = p.newGame().world.get('boss')!.c;
  await p.apply([{ op: 'linkPrefab', target: 'main#boss', prefab: null }], ai);
  const cut = await entityOf(dir, 'main', 'boss');
  assert.equal(cut.prefab, undefined);
  assert.equal(cut.components.Velocity.vy, 2);
  assert.deepEqual(p.newGame().world.get('boss')!.c, before);
  // つなぐと、プレハブと違う値だけが残る（値は変わらない）
  await p.apply([{ op: 'set', path: 'main#boss.Health.hp', value: 5 }, { op: 'linkPrefab', target: 'main#boss', prefab: 'foe2' }], ai);
  const linked = await entityOf(dir, 'main', 'boss');
  assert.equal(linked.prefab, 'foe2');
  assert.deepEqual(linked.components, { Health: { hp: 5 }, Lifetime: { frames: 30 } });
  assert.deepEqual(linked.remove, ['Effect']);
  // ないプレハブ
  await assert.rejects(p.apply([{ op: 'addEntity', scene: 'main', entity: { id: 'x', prefab: 'nai' } }], ai), /プレハブ nai はありません/);
  assert.match(await cmdCheck(dir), /^ok/);
});
