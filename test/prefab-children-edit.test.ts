// 子を持つプレハブの子を足す・消す・名前を変える・並べ替える、子の部品の足し外し（issue #135）。
// 足し引きは子を決めているプレハブでだけ。派生・置いた物の変えた値は名前で付いてくる（消した子の値は消えて、結果に並ぶ）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdInit, cmdPatch, cmdRun, cmdCheck, cmdGet } = await import('../src/cli/ages.ts');
const { Project } = await import('../src/project/project.ts');
const { readLocks, readTouched } = await import('../src/project/oplog.ts');

const human = { who: 'yamamoto', kind: 'human' as const, win: 'inspector' };
const keeper = { who: 'yamamoto', kind: 'human' as const, win: 'lock-manager' };
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };
const layer = (name: string, alpha: number) => ({ name, components: { Transform: {}, Shape: { kind: 'rect', w: 10, h: 10, color: '#336699', alpha } } });

async function project(code = ''): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-kids-')), 'g');
  await cmdInit(dir, 'g', 'none');
  await writeFile(join(dir, 'game', 'index.ts'), `import { defineSystem, type GameModule } from 'ages';
const sys = defineSystem({ name: 'probe', desc: '試す', reads: [], writes: [], update(ctx) {
${code}
} });
export const components: GameModule['components'] = [];
export const systems: GameModule['systems'] = [sys];
`);
  // 背景: 親＝背景、子＝重ねる層。派生（夜）と、シーンに置いた物がそれぞれ層の値を変えている
  await cmdPatch(dir, [
    { op: 'addPrefab', name: 'bg', components: { Transform: {} }, children: [layer('far', 1), layer('near', 1)] },
    { op: 'addPrefab', name: 'bg_night', base: 'bg' },
    { op: 'set', path: '@bg_night/near.Shape.alpha', value: 0.5 },
    { op: 'addEntity', scene: 'main', entity: { id: 'bg1', name: 'bg1', prefab: 'bg', components: {} } },
    { op: 'set', path: 'main#bg1/far.Shape.alpha', value: 0.3 },
  ] as any, false);
  return dir;
}

const get = async (dir: string, path: string) => (await cmdGet(dir, [path])).trim().replace(/^.* = /, '').replace(/★$/, '');

test('子を足す・並べ替える（並びは出す順＝同じ層なら描く順）。派生と置いた物にも出る', async () => {
  const dir = await project(`if (ctx.frame === 1) { const b = ctx.spawn('bg', {}); ctx.emit('kids', { ids: [...ctx.world.entities.values()].filter((e) => e.id.startsWith(b.id + '/')).map((e) => e.id.slice(b.id.length + 1)) }); }`);
  await cmdPatch(dir, [
    { op: 'addChild', parent: '@bg', child: layer('mist', 0.8), index: 1 },
    { op: 'addChild', parent: '@bg/mist', child: { name: 'spark', components: { Transform: { y: 2 } } } },
  ] as any, false);
  assert.match(await cmdRun(dir, { frames: '2', log: 'kids' }), /kids \{"ids":\["far","mist","mist\/spark","near"\]\}/);
  assert.equal(await get(dir, '@bg_night/mist.Shape.alpha'), '0.8', '派生にも出る');
  assert.equal(await get(dir, 'main#bg1/mist/spark.Transform.y'), '2', '置いた物にも出る');
  await cmdPatch(dir, [{ op: 'moveChild', path: '@bg/near', to: 0 }] as any, false);
  assert.match(await cmdRun(dir, { frames: '2', log: 'kids' }), /kids \{"ids":\["near","far","mist","mist\/spark"\]\}/);
  assert.match(await cmdCheck(dir), /^ok/);
  // 断る: 名前の重なり・派生・置いた物・別のプレハブの中・輪
  await assert.rejects(cmdPatch(dir, [{ op: 'addChild', parent: '@bg', child: layer('far', 1) }] as any, false), /@bg\/far はすでにあります/);
  await assert.rejects(cmdPatch(dir, [{ op: 'addChild', parent: '@bg_night', child: layer('x', 1) }] as any, false), /派生なので、子の足し引きはできません.*元 @bg/);
  await assert.rejects(cmdPatch(dir, [{ op: 'removeChild', path: 'main#bg1/far' }] as any, false), /置いた物の子では値を変えるだけ/);
  await cmdPatch(dir, [{ op: 'addPrefab', name: 'scene_set', components: { Transform: {} }, children: [{ name: 'sky', prefab: 'bg', components: {} }] }] as any, false);
  await assert.rejects(cmdPatch(dir, [{ op: 'addChild', parent: '@scene_set/sky', child: layer('x', 1) }] as any, false), /@scene_set\/sky は @bg を子にしているので、その中の子は @bg で足し引きします/);
  await assert.rejects(cmdPatch(dir, [{ op: 'removeChild', path: '@scene_set/sky/far' }] as any, false), /@bg で足し引きします/);
  await assert.rejects(cmdPatch(dir, [{ op: 'addChild', parent: '@bg', child: { name: 'loop', prefab: 'scene_set', components: {} } }] as any, false), /輪になっています/);
  // 参照先（@bg）に足せば、子にしている所（@scene_set/sky）にも出る
  await cmdPatch(dir, [{ op: 'addChild', parent: '@bg', child: layer('front', 1) }] as any, false);
  assert.equal(await get(dir, '@scene_set/sky/front.Shape.alpha'), '1');
});

test('子の名前を変えると、派生・置いた物の値・別のプレハブの中の値も付いてくる。消すと値も消えて結果に並ぶ', async () => {
  const dir = await project();
  await cmdPatch(dir, [
    { op: 'addPrefab', name: 'scene_set', components: { Transform: {} }, children: [{ name: 'sky', prefab: 'bg', components: {}, children: [{ name: 'near', components: { Shape: { alpha: 0.2 } } }] }] },
    { op: 'renameChild', path: '@bg/near', to: 'clouds' },
  ] as any, false);
  assert.equal(await get(dir, '@bg_night/clouds.Shape.alpha'), '0.5');
  assert.equal(await get(dir, '@scene_set/sky/clouds.Shape.alpha'), '0.2');
  assert.match(await cmdCheck(dir), /^ok/);
  const out = await cmdPatch(dir, [{ op: 'removeChild', path: '@bg/far' }] as any, false);
  assert.match(out, /main#bg1\/far\.Shape\.alpha/, '置いた物が書いた値が消えたことが分かる');
  await assert.rejects(cmdGet(dir, ['main#bg1/far.Shape.alpha']), /その子はありません/);
  assert.match(await cmdCheck(dir), /^ok/);
});

test('子の部品を付ける・外す（子にしたプレハブの部品は remove で外す。派生・置いた物が書いたその部品の値も消す）', async () => {
  const dir = await project();
  await cmdPatch(dir, [
    { op: 'addPrefab', name: 'scene_set', components: { Transform: {} }, children: [{ name: 'sky', prefab: 'bg', components: {} }] },
    { op: 'addComponent', target: '@bg/far', component: 'Text', values: { text: 'hi' } },
    { op: 'removeComponent', target: '@bg/far', component: 'Shape' },
    { op: 'addComponent', target: '@scene_set/sky', component: 'Shape', values: { kind: 'circle' } },
  ] as any, false);
  assert.equal(await get(dir, '@bg/far.Text.text'), 'hi');
  await assert.rejects(cmdGet(dir, ['main#bg1/far.Shape.alpha']), /Shape が付いていません/, '置いた物の値も消えた（残すと部品がまた付く）');
  await assert.rejects(cmdPatch(dir, [{ op: 'addComponent', target: '@bg_night/near', component: 'Text' }] as any, false), /派生なので/);
  // 子にしたプレハブ（@bg）の部品を外す: remove に書く。もう一度付けると remove から外れる
  await cmdPatch(dir, [{ op: 'removeComponent', target: '@scene_set/sky', component: 'Transform' }] as any, false);
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'prefabs', 'scene_set.prefab.json'), 'utf8'));
  assert.deepEqual(raw.children[0].remove, ['Transform']);
  assert.match(await cmdCheck(dir), /^ok/);
});

test('8段の入れ子（子・子にしたプレハブを交互に）: 出す・住所・派生・置いた物', async () => {
  const dir = await project(`if (ctx.frame === 1) { const r = ctx.spawn('robot', { Transform: { x: 100 } }); const d = ctx.child(r, 'body/arm_l/hand/finger/nail/tip/spark')!; ctx.emit('deep', { x: Math.round(ctx.worldOf(d)!.x) }); }`);
  const leaf = (name: string, kids: unknown[] = []) => ({ name, components: { Transform: { x: 1 } }, children: kids });
  await cmdPatch(dir, [
    { op: 'addPrefab', name: 'finger', components: { Transform: {} }, children: [leaf('nail', [leaf('tip', [leaf('spark')])])] },
    { op: 'addPrefab', name: 'hand', components: { Transform: {} }, children: [{ name: 'finger', prefab: 'finger', components: { Transform: { x: 1 } } }] },
    { op: 'addPrefab', name: 'arm', components: { Transform: {} }, children: [{ name: 'hand', prefab: 'hand', components: { Transform: { x: 1 } } }] },
    { op: 'addPrefab', name: 'robot', components: { Transform: {} }, children: [leaf('body', [{ name: 'arm_l', prefab: 'arm', components: { Transform: { x: 1 } } }, { name: 'arm_r', prefab: 'arm', components: { Transform: { x: -1 } } }])] },
    { op: 'set', path: '@robot/body/arm_l/hand/finger/nail/tip/spark.Transform.x', value: 10 },
    { op: 'addPrefab', name: 'robot_v', base: 'robot' },
    { op: 'set', path: '@robot_v/body/arm_r/hand/finger/nail/tip/spark.Transform.x', value: 20 },
    { op: 'addEntity', scene: 'main', entity: { id: 'r1', name: 'r1', prefab: 'robot', components: {} } },
    { op: 'set', path: 'main#r1/body/arm_l/hand/finger/nail/tip.Transform.x', value: 5 },
  ] as any, false);
  assert.match(await cmdCheck(dir), /^ok/);
  assert.match(await cmdRun(dir, { frames: '2', log: 'deep' }), /deep \{"x":116\}/);
  assert.equal(await get(dir, '@robot_v/body/arm_r/hand/finger/nail/tip/spark.Transform.x'), '20');
  assert.equal(await get(dir, '@robot_v/body/arm_l/hand/finger/nail/tip/spark.Transform.x'), '10');
  assert.equal(await get(dir, 'main#r1/body/arm_l/hand/finger/nail/tip.Transform.x'), '5');
  // 一番奥（@finger の中）の名前を変えると、上の段のすべての値が付いてくる
  await cmdPatch(dir, [{ op: 'renameChild', path: '@finger/nail/tip', to: 'point' }] as any, false);
  assert.equal(await get(dir, '@robot_v/body/arm_r/hand/finger/nail/point/spark.Transform.x'), '20');
  assert.equal(await get(dir, 'main#r1/body/arm_l/hand/finger/nail/point.Transform.x'), '5');
  assert.match(await cmdCheck(dir), /^ok/);
});

test('🔒 ロックされた値を持つ子は、AI からは消せない・名前を変えられない。人が名前を変えるとロックと★も付いてくる。Ctrl+Z で戻る', async () => {
  const dir = await project();
  const p = await Project.load(dir);
  await p.apply([{ op: 'set', path: 'main#bg1/near.Shape.alpha', value: 0.7 }], human);
  await p.lock(['@bg/far.Shape.alpha'], keeper);
  await assert.rejects(p.apply([{ op: 'removeChild', path: '@bg/far' }], ai, { force: true }), /🔒/);
  await assert.rejects(p.apply([{ op: 'renameChild', path: '@bg/far', to: 'back' }], ai, { force: true }), /🔒/);
  await p.apply([{ op: 'renameChild', path: '@bg/far', to: 'back' }, { op: 'renameChild', path: '@bg/near', to: 'front' }], human);
  assert.ok((await readLocks(dir))['@bg/back.Shape.alpha'], 'ロックが付いてくる');
  assert.ok((await readTouched(dir))['main#bg1/front.Shape.alpha'], '★が付いてくる');
  await p.undo(human);
  assert.ok((await readLocks(dir))['@bg/far.Shape.alpha'], '戻すとロックも戻る');
  assert.equal(await get(dir, 'main#bg1/near.Shape.alpha'), '0.7');
  // 人が消す: 置いた物の調整も消える。Ctrl+Z で戻る
  await p.apply([{ op: 'removeChild', path: '@bg/near' }], human);
  await assert.rejects(cmdGet(dir, ['main#bg1/near.Shape.alpha']));
  await p.undo(human);
  assert.equal(await get(dir, 'main#bg1/near.Shape.alpha'), '0.7');
});

test('子の親を変える（moveChild の parent）: 値・孫・派生と置いた物の値・🔒★が付いてくる。自分の下・別のプレハブの中へは動かせない。Ctrl+Z で戻る', async () => {
  const dir = await project();
  const p = await Project.load(dir);
  await p.apply([
    { op: 'addChild', parent: '@bg', child: { name: 'group', components: { Transform: { x: 100 } } } },
    { op: 'addChild', parent: '@bg/far', child: { name: 'spark', components: { Transform: { y: 3 } } } },
    { op: 'addPrefab', name: 'scene_set', components: { Transform: {} }, children: [{ name: 'sky', prefab: 'bg', components: {}, children: [{ name: 'far', components: { Shape: { alpha: 0.2 } } }] }] },
    { op: 'set', path: 'main#bg1/near.Shape.alpha', value: 0.7 },
  ], human);
  await p.lock(['@bg/far.Shape.alpha'], keeper);
  await assert.rejects(p.apply([{ op: 'moveChild', path: '@bg/far', parent: '@bg/group' }], ai, { force: true }), /🔒/);
  await p.apply([{ op: 'moveChild', path: '@bg/far', parent: '@bg/group' }, { op: 'moveChild', path: '@bg/near', parent: '@bg/group', to: 0 }], human);
  assert.deepEqual(p.docs.prefabs.get('bg')!.children!.map((c) => c.name), ['group']);
  assert.deepEqual(p.docs.prefabs.get('bg')!.children![0].children!.map((c) => c.name), ['near', 'far']);
  assert.equal(await get(dir, 'main#bg1/group/far.Shape.alpha'), '0.3', '置いた物の値が付いてくる');
  assert.equal(await get(dir, 'main#bg1/group/near.Shape.alpha'), '0.7');
  assert.equal(await get(dir, '@bg_night/group/near.Shape.alpha'), '0.5', '派生の値');
  assert.equal(await get(dir, '@scene_set/sky/group/far.Shape.alpha'), '0.2', '別のプレハブの中の値');
  assert.equal(await get(dir, '@bg/group/far/spark.Transform.y'), '3', '孫も');
  assert.ok((await readLocks(dir))['@bg/group/far.Shape.alpha'], 'ロックが付いてくる');
  assert.ok((await readTouched(dir))['main#bg1/group/near.Shape.alpha'], '★が付いてくる');
  assert.match(await cmdCheck(dir), /^ok/);
  await assert.rejects(p.apply([{ op: 'moveChild', path: '@bg/group', parent: '@bg/group/far' }], human), /自分や自分の子の下/);
  await assert.rejects(p.apply([{ op: 'moveChild', path: '@bg/group/far', parent: '@scene_set' }], human), /同じプレハブ/);
  await p.apply([{ op: 'addChild', parent: '@scene_set', child: { name: 'x', components: {} } }], human);
  await assert.rejects(p.apply([{ op: 'moveChild', path: '@scene_set/x', parent: '@scene_set/sky' }], human), /@bg を子にしているので、その中へは動かせません/);
  await p.undo(human);
  // Ctrl+Z で前の親・並びに戻る（ロックも）
  await p.undo(human);
  assert.deepEqual(p.docs.prefabs.get('bg')!.children!.map((c) => c.name), ['far', 'near', 'group']);
  assert.equal(await get(dir, 'main#bg1/near.Shape.alpha'), '0.7');
  assert.equal(await get(dir, 'main#bg1/far.Shape.alpha'), '0.3');
  assert.ok((await readLocks(dir))['@bg/far.Shape.alpha'], '戻すとロックも戻る');
});
