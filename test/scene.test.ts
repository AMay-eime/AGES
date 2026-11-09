// 段階2-7: シーン（切り替え・フェード・残す物・シーンごとのシステム・シーンの出し入れ・事前読み込み）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, defineSystem } from '../src/core/registry.ts';
import { Game, type Ctx } from '../src/core/game.ts';
import type { ProjectConfig, SceneDoc } from '../src/core/docs.ts';
import { Project } from '../src/project/project.ts';
import { readLocks, readTouched } from '../src/project/oplog.ts';
import { preloadSet } from '../src/core/assets.ts';
import { cmdCheck, cmdMap, cmdRun } from '../src/cli/ages.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const human = { who: 'yamamoto', kind: 'human' as const, win: 'hierarchy' };
const keeper = { who: 'yamamoto', kind: 'human' as const, win: 'lock-manager' };
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };
const CONFIG: ProjectConfig = { name: 't', fps: 10, seed: 1, view: { width: 100, height: 100, background: '#000' }, startScene: 'a', game: 'game/index.ts' };
const ent = (id: string, tags: string[] = [], x = 0) => ({ id, name: id, tags, components: { Transform: { x } } });

function setup(log: string[]) {
  const sys = (name: string, scenes?: string[]) => defineSystem({
    name, desc: name, scenes,
    start: (c: Ctx) => { log.push(`${name}.start@${c.scene.name}`); },
    update: () => {},
    exit: (c: Ctx) => { log.push(`${name}.exit@${c.scene.name}`); },
  });
  const reg = Registry.from({ components: [], systems: [sys('all'), sys('onlyB', ['b'])] });
  const a: SceneDoc = { name: 'a', entities: [ent('music', ['keep']), ent('hero'), ent('camera')] };
  const b: SceneDoc = { name: 'b', entities: [ent('music', [], 99), ent('boss'), ent('camera', [], 5)] };
  reg.scenes.set('a', a);
  reg.scenes.set('b', b);
  return new Game(reg, CONFIG, a);
}

test('goto: フェードで消えてから切り替わり、出てくる。残す物は残り、同じ ID なら残したほうを使う', () => {
  const log: string[] = [];
  const g = setup(log);
  g.step();
  g.ctx.scene.goto('b', { fade: 0.3, params: { stage: 2 }, keep: ['camera'] });
  const seen: string[] = [];
  for (let i = 0; i < 8; i++) { g.step(); const t = g.transition; seen.push(`${g.sceneName}${t ? `:${t.phase}${t.t.toFixed(2)}` : ''}`); }
  // fps10 で 0.3秒 = 3フレームずつ
  assert.deepEqual(seen, ['a:out0.33', 'a:out0.67', 'b:in0.00', 'b:in0.33', 'b:in0.67', 'b', 'b', 'b']);
  assert.deepEqual([...g.world.entities.keys()].sort(), ['boss', 'camera', 'music']);
  assert.equal(g.world.get('music')!.c.Transform.x, 0, 'tag keep の物は残り、次のシーンの同じ ID の物は置かない');
  assert.equal(g.world.get('camera')!.c.Transform.x, 0, 'keep で渡した物も残る');
  assert.deepEqual(g.ctx.scene.params, { stage: 2 });
  assert.equal(g.ctx.scene.frame, 5, '入ってからのフレーム（切り替わった後の5フレーム）');
  assert.deepEqual(g.sceneLog, [{ frame: 0, name: 'a' }, { frame: 4, name: 'b' }], 'b の最初のフレームは 4');
  assert.equal(g.counts.get('scene'), 1);
  // start はシーンに入るたびに、scenes を書いたシステムはそのシーンでだけ。exit は出る前に
  assert.deepEqual(log, ['all.start@a', 'all.exit@a', 'all.start@b', 'onlyB.start@b']);
  assert.throws(() => g.ctx.scene.goto('bb'), /シーン bb はありません。もしかして: b/);
});

test('フェードなしなら、そのフレームの終わりにすぐ切り替わる。restart は同じシーンを最初から', () => {
  const log: string[] = [];
  const g = setup(log);
  g.step();
  g.ctx.scene.goto('b', { params: { n: 1 } });
  g.step();
  assert.equal(g.sceneName, 'b');
  assert.equal(g.transition, null);
  g.world.get('boss')!.c.Transform.x = 50;
  g.ctx.scene.restart();
  g.step();
  assert.equal(g.world.get('boss')!.c.Transform.x, 0, '物は置き直される');
  assert.deepEqual(g.ctx.scene.params, { n: 1 }, 'params はそのまま');
  assert.equal(g.overlay(), null);
});

test('サンプル: 体力が尽きると得点を持って結果のシーンへ、fire でもう一度。毎回同じ結果', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  const moves = '0-150:@move_x=-1;150-450:@move_x=1;450-750:@move_x=-1;750-1050:@move_x=1;1050-1350:@move_x=-1';
  const keys = `0-1300:@fire;${moves}`;
  const out = await cmdRun(dir, { frames: '1400', keys, watch: 'score.Text.text', twice: true });
  assert.match(out, /scenes: main@0 → result@1092/);
  assert.match(out, /watch score\.Text\.text: — → SCORE 250/);
  assert.match(out, /再現性: OK/);
  const stop = await cmdRun(dir, { frames: '3000', keys: `0-3000:@fire;${moves}`, until: 'scene:result' });
  assert.match(stop, /停止:scene:result @f1092/);
  // 結果のシーンで fire を押し直すと main に戻る
  const again = await cmdRun(dir, { frames: '1400', keys: `0-1100:@fire;${moves};1200-1205:@fire` });
  assert.match(again, /scenes: main@0 → result@1092 → main@\d+/);
});

/** シーンの型を持つ表（stages）と、goto を書いたコードを足した写し */
async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  const file = join(dir, 'game/tables.ts');
  await writeFile(file, (await readFile(file, 'utf8')) + `
export const stages = defineTable({ name: 'stages', columns: { scene: { type: 'scene', default: '' } } });
`);
  await writeFile(join(dir, 'data/stages.table.json'), '{\n  "name": "stages",\n  "rows": [\n    {"id":"s1","scene":"result"}\n  ]\n}\n');
  return dir;
}

test('シーンの出し入れ: 作る（写し）・名前を変える（開始シーン・scene 型の値・ロック・★も）・説明・開始・消す（ロックがあれば人も消せない）', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  assert.deepEqual(p.validate(), []);
  await p.apply([{ op: 'addScene', name: 'stage2', copy: 'main', desc: '2面' }], ai);
  assert.equal(JSON.parse(await readFile(join(dir, 'scenes/stage2.scene.json'), 'utf8')).entities.length, p.docs.scenes.get('main')!.entities.length);
  await p.lock(['main#player.Player.speed'], keeper);
  await p.apply([{ op: 'set', path: 'main#spawner.Spawner.interval', value: 30 }], human);
  await assert.rejects(p.apply([{ op: 'renameScene', name: 'main', to: 'stage1' }], ai), /🔒 ロックされた値は変更できません: main#player\.Player\.speed/);
  const r = await p.apply([{ op: 'renameScene', name: 'main', to: 'stage1' }, { op: 'renameScene', name: 'result', to: 'over' }], human);
  assert.ok(r.warnings?.some((w) => /シーン result はコードの中にも書かれています（game\/systems\.ts:\d+/.test(w)), 'コードの goto は直さずに知らせる');
  assert.ok(!existsSync(join(dir, 'scenes/main.scene.json')) && existsSync(join(dir, 'scenes/stage1.scene.json')));
  assert.equal(JSON.parse(await readFile(join(dir, 'ages.project.json'), 'utf8')).startScene, 'stage1', '開始シーンも直る');
  assert.equal(JSON.parse(await readFile(join(dir, 'data/stages.table.json'), 'utf8')).rows[0].scene, 'over', 'scene 型の値も直る');
  assert.ok((await readLocks(dir))['stage1#player.Player.speed'], 'ロックも付いていく');
  assert.ok((await readTouched(dir))['stage1#spawner.Spawner.interval'], '★も付いていく');
  assert.match(await cmdCheck(dir), /goto\('result'\) のシーン result はありません/);
  await p.apply([{ op: 'setScene', name: 'stage2', start: true, desc: '2面（開始）' }], ai);
  assert.equal(JSON.parse(await readFile(join(dir, 'ages.project.json'), 'utf8')).startScene, 'stage2');
  await assert.rejects(p.apply([{ op: 'removeScene', name: 'stage2' }], ai), /開始シーンなので消せません/);
  await assert.rejects(p.apply([{ op: 'removeScene', name: 'over' }], ai), /使われているので消せません: \$stages\.s1\.scene/);
  await assert.rejects(p.apply([{ op: 'removeScene', name: 'stage1' }], ai), /🔒 ロックされた値は変更できません: stage1#player\.Player\.speed/);
  await p.unlock(['stage1#player.Player.speed'], keeper);
  await assert.rejects(p.apply([{ op: 'removeScene', name: 'stage1' }], ai), /人が調整した値に触れようとしています: stage1#spawner\.Spawner\.interval/);
  await p.lock(['stage1#player.Player.speed'], keeper);
  await assert.rejects(p.apply([{ op: 'removeScene', name: 'stage1' }], human), /🔒 ロックされています: stage1#player\.Player\.speed/, 'ロックのあるシーンは、人でもエディタからは消せない');
  await p.unlock(['stage1#player.Player.speed'], keeper);
  await p.apply([{ op: 'removeScene', name: 'stage1' }], human);
  assert.ok(!existsSync(join(dir, 'scenes/stage1.scene.json')));
  await assert.rejects(p.apply([{ op: 'addScene', name: 'stage 3' }], ai), /英数字・_・- だけ/);
  await assert.rejects(p.apply([{ op: 'addScene', name: 'over' }], ai), /すでにあります/);
  await assert.rejects(p.apply([{ op: 'set', path: '$stages.s1.scene', value: 'ovr' }], ai), /シーン ovr はありません。もしかして: over/);
});

test('コードの goto で使っているシーンは消せない。地図にシーンの説明・開始・行き先・シーンごとのシステム', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'set', path: '$stages.s1.scene', value: '' }], ai);
  await assert.rejects(p.apply([{ op: 'removeScene', name: 'result' }], ai), /シーン result はコードの中で使われているので消せません: game\/systems\.ts:\d+/);
  const map = await cmdMap(dir);
  assert.match(map, /goto の行き先（コード）: result main/);
  assert.match(map, /^main（\d+体） 開始$/m);
  assert.match(map, /^result（4体） ゲームオーバーの後の結果/m);
  assert.match(map, /toResult .* シーン:mainだけ/);
});

test('事前読み込み: 最初はプレハブ・表・コードが使うものとそのシーンの物、切り替えではそのシーンの物だけ', () => {
  const refs = new Map([['bg1.png', ['main#bg.Sprite.image']], ['bg2.png', ['boss#bg.Sprite.image']], ['shot.png', ['@bullet.Sprite.image']], ['icon.png', ['$items.a.icon']]]);
  assert.deepEqual(preloadSet(refs, 'main', true, ['coin.wav']).sort(), ['bg1.png', 'coin.wav', 'icon.png', 'shot.png']);
  assert.deepEqual(preloadSet(refs, 'boss', false), ['bg2.png']);
});
