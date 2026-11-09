// プレハブの派生: 元を受け継いで一部だけ変える・元の変更が伝わる・ロック・作る/消す/名前の変更・戻す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { cmdCheck, cmdGet, cmdMap } from '../src/cli/ages.ts';
import { resolvePrefab } from '../src/core/variant.ts';
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

const fileOf = async (dir: string, name: string) => JSON.parse(await readFile(join(dir, 'prefabs', `${name}.prefab.json`), 'utf8'));

test('派生を作ると、ファイルには変えた値だけが残り、使うときは元と重なる', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([
    { op: 'addPrefab', name: 'enemy_fast', base: 'enemy', desc: '速い敵', components: { Health: { hp: 1 } } },
    { op: 'set', path: '@enemy_fast.Velocity.vy', value: 6 },
  ], ai);
  assert.deepEqual(await fileOf(dir, 'enemy_fast'), { name: 'enemy_fast', base: 'enemy', desc: '速い敵', components: { Health: { hp: 1 }, Velocity: { vy: 6 } } });
  const r = resolvePrefab(p.docs.prefabs, 'enemy_fast');
  assert.deepEqual(Object.keys(r.components), Object.keys(p.docs.prefabs.get('enemy')!.components));
  assert.equal(r.components.Health.hp, 1);
  assert.deepEqual(r.tags, ['enemy']);
  // 物を出すときも重ねたもの
  const e = p.newGame().world.spawn('enemy_fast');
  assert.equal(e.c.Velocity.vy, 6);
  assert.equal(e.c.Sprite.image, p.docs.prefabs.get('enemy')!.components.Sprite.image);
  // 読むと受け継いだ値も見える
  assert.match(await cmdGet(dir, ['@enemy_fast.Sprite.image']), /tiles\.png|ships\.png/);
  // 地図: 元と、変えた所
  assert.match(await cmdMap(dir), /^@enemy_fast ← @enemy 速い敵 \[Transform Sprite Velocity Health Enemy Effect Collider\] tags:enemy 変:Velocity\.vy,Health\.hp$/m);
  assert.match(await cmdCheck(dir), /^ok/);
});

test('元を変えると、受け継いでいる派生にも伝わる。変えた値はそのまま', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'addPrefab', name: 'enemy_fast', base: 'enemy', components: { Health: { hp: 1 } } }], ai);
  await p.apply([{ op: 'set', path: '@enemy.Velocity.vy', value: 9 }, { op: 'set', path: '@enemy.Health.hp', value: 7 }], human);
  const r = resolvePrefab(p.docs.prefabs, 'enemy_fast');
  assert.equal(r.components.Velocity.vy, 9);
  assert.equal(r.components.Health.hp, 1);
  // 派生のファイルは変わらない。記録には「元の変更で」変わった値が残る（★は付かない）
  assert.deepEqual((await fileOf(dir, 'enemy_fast')).components, { Health: { hp: 1 } });
  const log = await readLog(dir);
  assert.ok(log.some((e) => e.path === '@enemy_fast.Velocity.vy' && e.via === '@enemy' && e.to === 9));
  assert.ok(!log.some((e) => e.path === '@enemy_fast.Health.hp' && e.via));
});

test('派生で元と同じ値にすると受け継ぐに戻り、revert で元の値・既定値に戻せる', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  const baseHp = p.docs.prefabs.get('enemy')!.components.Health.hp;
  await p.apply([{ op: 'addPrefab', name: 'enemy_fast', base: 'enemy', components: { Health: { hp: 1 }, Velocity: { vy: 6 } } }], ai);
  await p.apply([{ op: 'set', path: '@enemy_fast.Health.hp', value: baseHp }], ai);
  assert.deepEqual((await fileOf(dir, 'enemy_fast')).components, { Velocity: { vy: 6 } });
  await p.apply([{ op: 'revert', path: '@enemy_fast.Velocity.vy' }], ai);
  assert.deepEqual((await fileOf(dir, 'enemy_fast')).components, {});
  // 部品ごと戻す・外した部品を戻す
  await p.apply([{ op: 'removeComponent', target: '@enemy_fast', component: 'Effect' }], ai);
  assert.deepEqual((await fileOf(dir, 'enemy_fast')).remove, ['Effect']);
  assert.ok(!resolvePrefab(p.docs.prefabs, 'enemy_fast').components.Effect);
  await p.apply([{ op: 'revert', path: '@enemy_fast.Effect' }], ai);
  assert.equal((await fileOf(dir, 'enemy_fast')).remove, undefined);
  assert.ok(resolvePrefab(p.docs.prefabs, 'enemy_fast').components.Effect);
  // 派生で足した部品
  await p.apply([{ op: 'addComponent', target: '@enemy_fast', component: 'Particles', values: { burst: 3 } }], ai);
  assert.deepEqual((await fileOf(dir, 'enemy_fast')).components, { Particles: { burst: 3 } });
  // 派生でないものの revert は既定値に
  await p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 6 }], ai);
  await p.apply([{ op: 'revert', path: 'main#player.Player.speed' }], ai);
  assert.equal(p.docs.scenes.get('main')!.entities.find((e) => e.id === 'player')!.components.Player.speed, undefined);
  await assert.rejects(p.apply([{ op: 'revert', path: '@enemy_fast.Particles' }], ai), /元から受け継いだ部品だけ/);
});

test('派生のロック: 元を変えて、ロックされた受け継ぎの値が変わるなら止める', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'addPrefab', name: 'enemy_fast', base: 'enemy' }], ai);
  await p.lock(['@enemy_fast.Velocity.vy'], keeper);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Velocity.vy', value: 9 }], ai), /ロックされた値も変えてしまいます: @enemy_fast\.Velocity\.vy/);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Velocity.vy', value: 9 }], human), /ロックされています: @enemy_fast\.Velocity\.vy/);
  // ほかの値は変えられる
  await p.apply([{ op: 'set', path: '@enemy.Health.hp', value: 4 }], ai);
  assert.equal(resolvePrefab(p.docs.prefabs, 'enemy_fast').components.Health.hp, 4);
});

test('プレハブを作る・消す・名前を変える・元を変える（参照・派生の元・ロック・★も直る）', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'addPrefab', name: 'enemy_fast', base: 'enemy', components: { Health: { hp: 1 } } }], ai);
  await assert.rejects(p.apply([{ op: 'removePrefab', name: 'enemy' }], ai), /使われているので消せません: main#spawner\.Spawner\.prefab（既定値）, @enemy_fast（派生の元）/);
  await assert.rejects(p.apply([{ op: 'removePrefab', name: 'se_shot' }], ai), /コードの中で使われているので消せません: game\/systems\.ts:\d+/);
  await assert.rejects(p.apply([{ op: 'addPrefab', name: 'x', base: 'nai' }], ai), /プレハブ nai はありません/);
  await assert.rejects(p.apply([{ op: 'setPrefab', name: 'enemy', base: 'enemy_fast' }], ai), /輪になる/);
  await p.apply([{ op: 'set', path: '@enemy.Health.hp', value: 5 }], human);
  const r = await p.apply([{ op: 'renamePrefab', name: 'enemy', to: 'foe' }], human);
  assert.equal(p.docs.prefabs.get('enemy_fast')!.base, 'foe');
  assert.equal(p.docs.scenes.get('main')!.entities.find((e) => e.id === 'spawner')!.components.Spawner.prefab, 'foe');
  assert.match(JSON.stringify(r.warnings ?? []), /^\[\]$|コードの中にも/);
  const touched = JSON.parse(await readFile(join(dir, '.ages', 'touched.json'), 'utf8'));
  assert.ok(touched['@foe.Health.hp'] && !touched['@enemy.Health.hp']);
  // 元に戻すと名前も戻る
  await p.undo(human);
  const p2 = await Project.load(dir);
  assert.ok(p2.docs.prefabs.has('enemy') && p2.docs.prefabs.get('enemy_fast')!.base === 'enemy');
  // 切り離すと、今の値をまるごと持つふつうのプレハブになる
  await p2.apply([{ op: 'setPrefab', name: 'enemy_fast', base: null }], ai);
  const f = await fileOf(dir, 'enemy_fast');
  assert.equal(f.base, undefined);
  assert.equal(f.components.Health.hp, 1);
  assert.ok(f.components.Sprite);
  // ふつうのプレハブを派生にしても、値は変わらない（元と違う所だけが残る）
  await p2.apply([{ op: 'setPrefab', name: 'enemy_fast', base: 'enemy' }], ai);
  assert.deepEqual((await fileOf(dir, 'enemy_fast')).components, { Health: { hp: 1 } });
  // 写し（派生にしない）・コードの中の名前の検証
  await p2.apply([{ op: 'addPrefab', name: 'enemy2', copy: 'enemy_fast' }], ai);
  assert.equal((await fileOf(dir, 'enemy2')).base, undefined);
  await writeFile(join(dir, 'game', 'extra.ts'), "export const f = (ctx: any) => ctx.spawn('enemy_fsat');\n");
  assert.match(await cmdCheck(dir), /game\/extra\.ts:1: プレハブ enemy_fsat はありません。もしかして: enemy_fast/);
});

test('派生の検証: ない元・輪・元にない部品を外す', async () => {
  const dir = await fresh();
  await writeFile(join(dir, 'prefabs', 'a.prefab.json'), JSON.stringify({ name: 'a', base: 'b', components: {} }));
  await writeFile(join(dir, 'prefabs', 'b.prefab.json'), JSON.stringify({ name: 'b', base: 'a', components: {} }));
  await writeFile(join(dir, 'prefabs', 'c.prefab.json'), JSON.stringify({ name: 'c', base: 'enemy', remove: ['Camera'], components: {} }));
  await writeFile(join(dir, 'prefabs', 'd.prefab.json'), JSON.stringify({ name: 'd', base: 'nai', components: {} }));
  const errs = (await Project.load(dir)).validate().join('\n');
  assert.match(errs, /派生の元が輪になっています/);
  assert.match(errs, /@c\.remove: 元 @enemy に部品 Camera はありません/);
  assert.match(errs, /@d の元 @nai がありません/);
});
