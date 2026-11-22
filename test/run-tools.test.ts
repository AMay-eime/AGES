// ages run の小さな直し: --watch の番号を --log とそろえる（#151）・--log の物の欄（#150）・--scene と --spawn（#149）、
// ages export --out の web/web と場所の出し方（#153）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdInit, cmdPatch, cmdRun, cmdExport, parseLogSpecs } = await import('../src/cli/ages.ts');

async function project(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-runtools-')), 'g');
  await cmdInit(dir, 'g', 'none');
  await writeFile(join(dir, 'game', 'index.ts'), `import { defineComponent, defineSystem, type GameModule } from 'ages';
const Bullet = defineComponent({ name: 'Bullet', desc: '弾', fields: { kind: { type: 'string', default: 'small' } } });
const Count = defineComponent({ name: 'Count', desc: '数', fields: { n: { type: 'int', default: 0 } } });
// 弾がいたら、そのステップで出来事を出し、数を増やし、弾を消す
const hit = defineSystem({ name: 'hit', desc: '当たる', reads: ['Bullet'], writes: ['Count'], update(ctx) {
  for (const e of ctx.world.query('Bullet')) {
    ctx.emit('hit', { entity: e.id });
    (ctx.world.get('counter')!.c.Count as { n: number }).n++;
    ctx.destroy(e.id);
  }
} });
export const components: GameModule['components'] = [Bullet, Count];
export const systems: GameModule['systems'] = [hit];
`);
  await cmdPatch(dir, [
    { op: 'addPrefab', name: 'bullet', components: { Transform: {}, Bullet: {} } },
    { op: 'addPrefab', name: 'marker', components: { Transform: {} } },
    { op: 'addEntity', scene: 'main', entity: { id: 'player', name: 'player', components: { Transform: { x: 100, y: 50 } } } },
    { op: 'addEntity', scene: 'main', entity: { id: 'counter', name: 'counter', components: { Count: {} } } },
  ] as any, false);
  return dir;
}

test('--scene と --spawn: そのシーンの中に、フレーム・位置・値を決めて出す。--log の物の欄・--watch の番号は出来事と同じステップ', async () => {
  const dir = await project();
  const out = await cmdRun(dir, { scene: 'main', frames: '6', spawn: 'bullet@player+5,0:3{Bullet.kind=big};bullet@10,20:3;marker@player+5,-1:2', log: 'hit[entity.Bullet.kind]', watch: 'counter.Count.n,@marker.Transform.x,@marker.Transform.y', every: '1' });
  assert.match(out, /^f2 出した: @marker → marker~\d+$/m);
  assert.match(out, /^f3 出した: @bullet → bullet~\d+$/m);
  // 出来事は出たときに読む（そのステップで消える弾でも種類が読める）
  assert.match(out, /^f3 hit \{"entity":"bullet~\d+"\} entity\.Bullet\.kind=big$/m);
  assert.match(out, /^f3 hit \{"entity":"bullet~\d+"\} entity\.Bullet\.kind=small$/m);
  // --watch の f3 は、3番目のステップを終えた値（同じステップの出来事と同じ番号。#151）
  assert.match(out, /^f2 n=0 x=105 y=49$/m);
  assert.match(out, /^f3 n=2 x=105 y=49$/m);
  await assert.rejects(cmdRun(dir, { scene: 'main', frames: '6', spawn: 'nope@0,0:1' }), /--spawn の nope: プレハブはありません/);
  await assert.rejects(cmdRun(dir, { scene: 'main', frames: '6', spawn: 'bullet@0,0:1{kind}' }), /部品\.欄=値 です/);
  assert.match(await cmdRun(dir, { scene: 'main', frames: '6', spawn: 'bullet@ghost+0,0:1' }), /⚠ f1 --spawn の @bullet を出せません: @ghost がいません/);
  // --scene がなければ、今までどおりの試し（空のシーンの真ん中）
  assert.match(await cmdRun(dir, { frames: '3', spawn: 'marker' }), /^run 試し\(@marker\)/);
});

test('--log の書き方: 名前[中身の名前.部品.欄]、[ ] の中の , では区切らない', () => {
  assert.deepEqual(parseLogSpecs('a,b[entity.Bullet.kind,target.Health.hp],*'), [{ name: 'a', fields: [] }, { name: 'b', fields: ['entity.Bullet.kind', 'target.Health.hp'] }, { name: '*', fields: [] }]);
  assert.throws(() => parseLogSpecs('b[kind]'), /中身の名前\.部品\.欄 です/);
});

test('export --out: 最後が web ならその下に web を作らない。今いるフォルダの外なら絶対パスで出す', async () => {
  const dir = await project();
  const out = join(await mkdtemp(join(tmpdir(), 'ages-out-')), 'web');
  const r = await cmdExport(dir, { out });
  assert.ok((await stat(join(out, 'index.html'))).isFile(), 'web/web にならない');
  assert.match(r, new RegExp(`書き出しました: ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}（`), '外なら絶対パス');
});
