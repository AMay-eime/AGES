// 子を持つプレハブ（issue #130）: 作る・出す（親と一緒に、ID は 親/名前）・ctx.child・子の住所 @親/子.部品.欄・派生・子にしたプレハブ・名前の変更と消す・確かめ
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdInit, cmdPatch, cmdRun, cmdCheck, cmdGet, cmdMap } = await import('../src/cli/ages.ts');

async function project(code = ''): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-nest-')), 'g');
  await cmdInit(dir, 'g', 'none');
  await writeFile(join(dir, 'game', 'index.ts'), `import { defineSystem, type GameModule } from 'ages';
const sys = defineSystem({ name: 'probe', desc: '試す', reads: [], writes: ['Transform'], update(ctx) {
${code}
} });
export const components: GameModule['components'] = [];
export const systems: GameModule['systems'] = [sys];
`);
  await cmdPatch(dir, [
    // 武器: 先に銃口の光（子）
    { op: 'addPrefab', name: 'gun', components: { Transform: {}, Shape: { kind: 'rect', w: 6, h: 12, color: '#888888' } }, children: [{ name: 'muzzle', components: { Transform: { y: -8 }, Shape: { kind: 'circle', w: 4, h: 4, color: '#ffff00' } } }] },
    // 自機の組: 左右に武器（右は反転）・中にそのままの子
    { op: 'addPrefab', name: 'ship', components: { Transform: {}, Shape: { kind: 'rect', w: 16, h: 16, color: '#00aaff' } }, children: [
      { name: 'gun_l', prefab: 'gun', components: { Transform: { x: -12 } } },
      { name: 'gun_r', prefab: 'gun', components: { Transform: { x: 12, sx: -1 } }, children: [{ name: 'muzzle', components: { Shape: { color: '#ff0000' } } }] },
      { name: 'core', components: { Transform: { y: 2 } } },
    ] },
  ] as any, false);
  return dir;
}

test('出すと子と孫も出る（ID は 親/名前・位置は親から見た値・子にしたプレハブの値を変えられる）。ctx.child で引ける', async () => {
  const dir = await project(`
  if (ctx.frame === 1) ctx.spawn('ship', { Transform: { x: 100, y: 50 } });
  if (ctx.frame === 3) {
    const s = ctx.world.query('Transform').find((e) => e.prefab === 'ship')!;
    const m = ctx.child(s, 'gun_r/muzzle')!;
    const w = ctx.worldOf(m)!;
    ctx.emit('probe', { id: m.id, color: m.c.Shape.color, x: Math.round(w.x), y: Math.round(w.y), l: ctx.child(s.id, 'gun_l')!.prefab, none: ctx.child(s, 'nope') === undefined });
  }
  if (ctx.frame === 5) ctx.destroy(ctx.world.query('Transform').find((e) => e.prefab === 'ship')!.id);
  if (ctx.frame === 7) ctx.emit('left', { n: ctx.world.query('Transform').length });`);
  assert.match(await cmdCheck(dir), /^ok/);
  const out = await cmdRun(dir, { frames: '8', log: 'probe,left', watch: '@ship/gun_l.Transform.x,@ship/gun_r/muzzle.Shape.color' });
  assert.match(out, /^f3 probe \{"id":"ship~1\/gun_r\/muzzle","color":"#ff0000","x":112,"y":42,"l":"gun","none":true\}$/m, out);
  // 親が消えると子も孫も消える
  assert.match(out, /^f7 left \{"n":0\}$/m);
  assert.match(out, /^watch @ship\/gun_l\.Transform\.x: — → —$/m);
  const mid = await cmdRun(dir, { frames: '4', watch: '@ship.Transform.x,@ship/gun_l.Transform.x,@ship/gun_r/muzzle.Shape.color,@ship[*].Transform.x' });
  assert.match(mid, /^watch @ship\.Transform\.x: — → 100$/m, mid);
  assert.match(mid, /^watch @ship\/gun_l\.Transform\.x: — → -12$/m);
  assert.match(mid, /^watch @ship\/gun_r\/muzzle\.Shape\.color: — → #ff0000$/m);
  assert.match(mid, /^watch @ship\[\*\]\.Transform\.x: — → ship~1=100$/m, '子は @プレハブ[*] に入らない');
});

test('子の住所: 読むのは重ねた値、書くのはファイルの子（子にしたプレハブの子なら、変えた値だけ）。足し外しは断る', async () => {
  const dir = await project();
  assert.equal((await cmdGet(dir, ['@ship/gun_l/muzzle.Shape.color'])).trim(), '@ship/gun_l/muzzle.Shape.color = #ffff00');
  assert.equal((await cmdGet(dir, ['@ship/gun_r/muzzle.Shape.color'])).trim(), '@ship/gun_r/muzzle.Shape.color = #ff0000');
  assert.equal((await cmdGet(dir, ['@ship/gun_r.Transform.y'])).trim(), '@ship/gun_r.Transform.y = 0（既定値）');
  await cmdPatch(dir, [{ op: 'set', path: '@ship/gun_l/muzzle.Transform.y', value: -10 }, { op: 'set', path: '@ship/core.Transform.x', value: 3 }], false);
  const ship = JSON.parse(await readFile(join(dir, 'prefabs', 'ship.prefab.json'), 'utf8'));
  assert.deepEqual(ship.children[0], { name: 'gun_l', prefab: 'gun', components: { Transform: { x: -12 } }, children: [{ name: 'muzzle', components: { Transform: { y: -10 } } }] });
  assert.deepEqual(ship.children[2].components, { Transform: { y: 2, x: 3 } });
  // 元（gun）を直すと、変えていない子の値が変わる
  await cmdPatch(dir, [{ op: 'set', path: '@gun/muzzle.Shape.w', value: 9 }], false);
  assert.equal((await cmdGet(dir, ['@ship/gun_l/muzzle.Shape.w'])).trim(), '@ship/gun_l/muzzle.Shape.w = 9');
  await assert.rejects(cmdPatch(dir, [{ op: 'set', path: '@ship/gun_x.Transform.x', value: 1 }], false), /@ship\/gun_x: その子はありません.*gun_l/);
  await assert.rejects(cmdPatch(dir, [{ op: 'set', path: '@ship/core.Sprite.alpha', value: 1 }], false), /コンポーネント Sprite が付いていません/);
  await assert.rejects(cmdPatch(dir, [{ op: 'addComponent', target: '@ship/core', component: 'Sprite' } as any], false), /子では値を変えるだけ/);
});

test('派生は子の値を変えるだけ。名前の変更は子にした所も直る。子にしているプレハブは消せない。輪・ない子は断る', async () => {
  const dir = await project();
  await cmdPatch(dir, [{ op: 'addPrefab', name: 'ship_red', base: 'ship' }, { op: 'set', path: '@ship_red/gun_r/muzzle.Shape.w', value: 7 }, { op: 'set', path: '@ship_red.Shape.color', value: '#ff0000' }] as any, false);
  const red = JSON.parse(await readFile(join(dir, 'prefabs', 'ship_red.prefab.json'), 'utf8'));
  assert.deepEqual(red.children, [{ name: 'gun_r', components: {}, children: [{ name: 'muzzle', components: { Shape: { w: 7 } } }] }]);
  assert.equal((await cmdGet(dir, ['@ship_red/gun_r/muzzle.Shape.color'])).trim(), '@ship_red/gun_r/muzzle.Shape.color = #ff0000', '元の値を受け継ぐ');
  // 派生の値をもう一度変えても、子の変えた値は残る
  await cmdPatch(dir, [{ op: 'set', path: '@ship_red.Shape.w', value: 20 }], false);
  assert.equal((await cmdGet(dir, ['@ship_red/gun_r/muzzle.Shape.w'])).trim(), '@ship_red/gun_r/muzzle.Shape.w = 7');
  const out = await cmdRun(dir, { frames: '2', spawn: 'ship_red' });
  assert.match(out, /^entities: 6 \(@ship_red @gun×2 ship_red~1\/gun_l\/muzzle /m, out);

  await cmdPatch(dir, [{ op: 'renamePrefab', name: 'gun', to: 'cannon' }], false);
  const ship = JSON.parse(await readFile(join(dir, 'prefabs', 'ship.prefab.json'), 'utf8'));
  assert.deepEqual(ship.children.map((c: { prefab?: string }) => c.prefab), ['cannon', 'cannon', undefined]);
  await assert.rejects(cmdPatch(dir, [{ op: 'removePrefab', name: 'cannon' }], false), /@ship\/gun_l（子）/);
  await assert.rejects(cmdPatch(dir, [{ op: 'addPrefab', name: 'loop', components: { Transform: {} }, children: [{ name: 'me', prefab: 'loop', components: {} }] }] as any, false), /プレハブ loop はありません/);
  await assert.rejects(cmdPatch(dir, [{ op: 'set', path: '@cannon.Transform.x', value: 0 }, { op: 'addPrefab', name: 'a', components: {}, children: [{ name: 'x', prefab: 'ship', components: {} }] }, { op: 'addPrefab', name: 'b', base: 'ship', children: [{ name: 'new_one', components: {} }] }] as any, false), /@b\/new_one: 元にない子です/);
  await assert.rejects(cmdPatch(dir, [{ op: 'addPrefab', name: 'c', components: {}, children: [{ name: 'a.b', components: {} }] }] as any, false), /子の名前 "a\.b"/);
  assert.match(await cmdCheck(dir), /^ok/);
  // 地図: 子の名前と、子にしたプレハブ・孫の数。派生は変えた子の値
  const map = await cmdMap(dir);
  assert.match(map, /^@ship \[Transform Shape\] 子:gun_l←@cannon\(1\),gun_r←@cannon\(1\),core/m, map);
  assert.match(map, /^@ship_red ← @ship \[Transform Shape\] 子:.* 変:Shape\.color,Shape\.w,\/gun_r\/muzzle\.Shape\.w/m);
});

test('置いた物ごとの子の値（段3）: シーン#置いた物/子.部品.欄 で読み書き・出すとその値・プレハブを直すと変えていない値は伝わる・切り離しは断る', async () => {
  const dir = await project(`
  if (ctx.frame === 1) {
    const g = ctx.child('boss', 'gun_r/muzzle')!;
    ctx.emit('probe', { color: g.c.Shape.color, w: g.c.Shape.w, x: ctx.child('boss', 'gun_l')!.c.Transform.x, other: ctx.child('boss2', 'gun_l')!.c.Transform.x });
  }`);
  await cmdPatch(dir, [
    { op: 'addEntity', scene: 'main', entity: { id: 'boss', name: 'boss', prefab: 'ship', components: { Transform: { x: 50 } } } },
    { op: 'addEntity', scene: 'main', entity: { id: 'boss2', name: 'boss2', prefab: 'ship', components: {} } },
    { op: 'set', path: 'main#boss/gun_r/muzzle.Shape.color', value: '#00ff00' },
    { op: 'set', path: 'main#boss/gun_l.Transform.x', value: -30 },
  ] as any, false);
  const scene = JSON.parse(await readFile(join(dir, 'scenes', 'main.scene.json'), 'utf8'));
  const boss = scene.entities.find((e: { id: string }) => e.id === 'boss');
  assert.deepEqual(boss.children, [{ name: 'gun_r', components: {}, children: [{ name: 'muzzle', components: { Shape: { color: '#00ff00' } } }] }, { name: 'gun_l', components: { Transform: { x: -30 } } }]);
  assert.ok(!scene.entities.find((e: { id: string }) => e.id === 'boss2').children, 'もう1つには入らない');
  assert.equal((await cmdGet(dir, ['main#boss/gun_r/muzzle.Shape.color'])).trim(), 'main#boss/gun_r/muzzle.Shape.color = #00ff00');
  // プレハブを直すと、置いた物の変えていない値は伝わる
  await cmdPatch(dir, [{ op: 'set', path: '@gun/muzzle.Shape.w', value: 11 }], false);
  let out = await cmdRun(dir, { frames: '2', log: 'probe' });
  assert.match(out, /^f1 probe \{"color":"#00ff00","w":11,"x":-30,"other":-12\}$/m, out);
  // インスタンスのほかの値を変えても、子の値は残る
  await cmdPatch(dir, [{ op: 'set', path: 'main#boss.Transform.y', value: 9 }], false);
  out = await cmdRun(dir, { frames: '2', log: 'probe' });
  assert.match(out, /"color":"#00ff00"/);
  // 地図に置いた物ごとの子の値
  assert.match(await cmdMap(dir), /boss .*\/gun_r\/muzzle\.Shape\.color/);
  await assert.rejects(cmdPatch(dir, [{ op: 'linkPrefab', target: 'main#boss', prefab: null }] as any, false), /子を持つプレハブ @ship のインスタンスなので、切り離せません/);
  await assert.rejects(cmdPatch(dir, [{ op: 'set', path: 'main#boss/nope.Transform.x', value: 1 }], false), /main#boss\/nope: その子はありません/);
  await assert.rejects(cmdPatch(dir, [{ op: 'addComponent', target: 'main#boss/core', component: 'Sprite' } as any], false), /置いた物の子では値を変えるだけ/);
  assert.match(await cmdCheck(dir), /^ok/);
});
