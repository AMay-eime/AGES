// 段階2-13: セーブ（進み具合と設定の保存・読み込み）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../src/core/registry.ts';
import { defineComponent } from '../src/core/schema.ts';
import { Game } from '../src/core/game.ts';
import type { ProjectConfig, SceneDoc } from '../src/core/docs.ts';
import { LocalStore, MemoryStore, SETTINGS_KEY, type SaveStore } from '../src/core/save.ts';
import { Project } from '../src/project/project.ts';
import { cmdCheck, cmdMap, cmdRun } from '../src/cli/ages.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const CONFIG: ProjectConfig = { name: 't', fps: 60, seed: 1, view: { width: 400, height: 300, background: '#000' }, startScene: 'a', game: 'game/index.ts' };
const Coin = defineComponent({ name: 'Coin', desc: '', fields: { value: { type: 'int', default: 1 }, shiny: { type: 'bool', default: false } } });

function game(store: SaveStore = new MemoryStore(), config: ProjectConfig = CONFIG) {
  const reg = Registry.from({ components: [Coin], systems: [] });
  reg.tableData.set('actions', { name: 'actions', rows: [{ id: 'fire', keys: ['KeyZ'] }] } as never);
  const scene: SceneDoc = {
    name: 'a',
    entities: [
      { id: 'player', name: 'player', tags: ['save'], components: { Transform: { x: 10 } } },
      { id: 'c1', name: 'c1', tags: ['coin'], components: { Transform: { x: 1 }, Coin: { value: 5 } } },
      { id: 'c2', name: 'c2', tags: ['coin'], components: { Transform: { x: 2 }, Coin: {} } },
    ],
  };
  reg.scenes.set('a', scene);
  return new Game(reg, config, scene, 1, { store });
}

test('ctx.save: 読む・書く・消す・キーの一覧（/ でスロット）。写しを返し、JSON にできない値と $ のキーは止める', () => {
  const store = new MemoryStore();
  const g = game(store);
  const s = g.ctx.save;
  assert.equal(s.get('best', 0), 0);
  s.set('best', 1200);
  s.set('slot1/progress', { stage: 3, items: ['key'] });
  s.set('slot2/progress', { stage: 1, items: [] });
  assert.deepEqual(s.keys('slot'), ['slot1/progress', 'slot2/progress']);
  const p = s.get<{ items: string[] }>('slot1/progress');
  p.items.push('sword');
  assert.deepEqual(s.get('slot1/progress'), { stage: 3, items: ['key'] }, '写しなので、set しないと変わらない');
  assert.equal(store.data.best, '1200', 'すぐ置き場所に書く');
  s.remove('slot2/progress');
  assert.ok(!s.has('slot2/progress'));
  assert.throws(() => s.set('x', { a: NaN }), /a が NaN/);
  assert.throws(() => s.set('x', new Map()), /保存できない種類です（Map）/);
  assert.throws(() => s.set('$settings', 1), /\$ で始まるキーは AGES が使います/);
  // 同じ置き場所で始めれば、続きから
  assert.equal(game(store).ctx.save.get('best'), 1200);
  assert.deepEqual([...g.save.writes], [['best', 1], ['slot1/progress', 1], ['slot2/progress', 2]]);
});

test('設定（キーの割り当て・音量）は、変えたら自動で保存し、次に始めるときに戻す。manual なら自分で', () => {
  const store = new MemoryStore();
  const g = game(store);
  g.ctx.input.bind('fire', { keys: ['KeyX'] });
  g.step();
  assert.deepEqual(JSON.parse(store.data[SETTINGS_KEY]).bindings, { fire: { keys: ['KeyX'] } });
  const g2 = game(store);
  g2.step({ buttons: ['KeyX'] });
  assert.ok(g2.ctx.input.isDown('fire'), '変えた割り当てで動く');
  const manual = new MemoryStore();
  const g3 = game(manual, { ...CONFIG, save: { settings: 'manual' } });
  g3.ctx.input.bind('fire', { keys: ['KeyC'] });
  g3.step();
  assert.equal(manual.data[SETTINGS_KEY], undefined);
});

test('saveWorld / loadWorld: タグで選んだ物をまとめて保存し、戻す（置きかえ・足す・消す）。型が変わっていても合わせる', () => {
  const store = new MemoryStore();
  const g = game(store);
  assert.equal(g.ctx.save.saveWorld('slot1/coins', { tags: ['coin'] }), 2);
  // 1つ拾って（消して）、残りの値を変えてから戻す → 保存のときに戻る
  g.world.destroy('c1');
  g.world.flush();
  g.world.get('c2')!.c.Coin.value = 99;
  g.ctx.save.loadWorld('slot1/coins');
  g.world.flush();
  assert.deepEqual([g.world.get('c1')!.c.Coin.value, g.world.get('c2')!.c.Coin.value], [5, 1]);
  // 保存の後に拾った物（保存にない物）は、戻すと消える
  const g2 = game(store);
  g2.world.add({ id: 'c3', name: 'c3', tags: ['coin'], components: { Coin: {} } } as never);
  g2.ctx.save.loadWorld('slot1/coins');
  g2.world.flush();
  assert.equal(g2.world.get('c3'), undefined);
  // 型が変わった保存: なくなった値は捨て、合わない値は既定値、ないコンポーネントは ⚠
  store.write('old', JSON.stringify({ $world: 1, pick: { tags: ['coin'] }, entities: [{ id: 'c1', name: 'c1', tags: ['coin'], c: { Coin: { value: 'many', color: 'gold' }, Gem: { size: 1 } } }] }));
  const g3 = game(store);
  assert.equal(g3.ctx.save.loadWorld('old'), 1);
  g3.world.flush();
  assert.deepEqual(g3.world.get('c1')!.c.Coin, { value: 1, shiny: false });
  assert.ok([...g3.warnings].some((w) => /Coin\.value は今の型に合わない/.test(w)));
  assert.ok([...g3.warnings].some((w) => /Gem は今はないコンポーネント/.test(w)));
  assert.equal(g3.ctx.save.loadWorld('nothing'), 0);
  assert.ok([...g3.warnings].some((w) => /loadWorld\("nothing"\): 保存がありません/.test(w)));
  assert.throws(() => g3.ctx.save.saveWorld('x', {}), /\{ tags: \['save'\] \} か \{ ids: \['player'\] \}/);
});

test('ブラウザの置き場所（localStorage）はプロジェクトごとに分ける', () => {
  const mem = new Map<string, string>();
  const ls = { get length() { return mem.size; }, key: (i: number) => [...mem.keys()][i] ?? null, getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear() } as Storage;
  const a = new LocalStore('ages.save.a.', ls), b = new LocalStore('ages.save.b.', ls);
  game(a).ctx.save.set('best', 1);
  assert.deepEqual(a.load(), { best: '1' });
  assert.deepEqual(b.load(), {});
  a.clear();
  assert.equal(mem.size, 0);
});

test('ages run: --save の保存データから始め、要約の save: に書いたキー、--save-out で書き出す。記録の save も使う。saves/ は検証・地図に出る', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  const keys = '0-900:KeyZ;100-200:ArrowLeft;400-500:ArrowRight';
  const first = await cmdRun(dir, { frames: '900', keys, 'save-out': 'saves/after.save.json', watch: 'score.Text.text' });
  assert.match(first, /save: 書いた best×1（終わりの保存: best → saves\/after\.save\.json）/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'saves/after.save.json'), 'utf8')), { best: 150 });
  const high = await cmdRun(dir, { frames: '900', keys, save: 'saves/high-score.save.json', watch: 'score.Text.text' });
  assert.match(high, /SCORE 150 {3}BEST 5000/);
  assert.doesNotMatch(high, /^save:/m, '最高得点を超えなければ書かない');
  // エディタの記録に入っている、始めたときの保存データも使う
  // recordings/ は空のフォルダなので Git に入らない（取り込んだばかりの写しにはない）
  await mkdir(join(dir, 'recordings'), { recursive: true });
  await writeFile(join(dir, 'recordings/r.input.json'), JSON.stringify({ seed: 1, scene: 'result', frames: 5, save: { best: 777 }, events: [] }));
  assert.match(await cmdRun(dir, { scene: 'result', frames: '5', input: 'recordings/r.input.json', watch: 'score.Text.text' }), /BEST 777/);
  assert.match(await cmdMap(dir), /保存データ（ages run --save で、その状態から始める）: saves\/after\.save\.json\(best\) {2}saves\/high-score\.save\.json\(best\)/);
  await writeFile(join(dir, 'saves/bad.save.json'), '{ broken');
  await writeFile(join(dir, 'saves/old.save.json'), JSON.stringify({ w: { $world: 1, pick: { tags: ['x'] }, entities: [{ id: 'a', name: 'a', tags: [], c: { Healt: {} } }] } }));
  const check = await cmdCheck(dir);
  assert.match(check, /saves\/bad\.save\.json: JSON として読めません/);
  assert.match(check, /saves\/old\.save\.json: w の a の Healt はないコンポーネントです。もしかして: Health/);
  assert.ok((await Project.load(dir)).saves.size === 4);
});
