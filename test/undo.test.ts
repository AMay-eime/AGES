// 段階2-8: 元に戻す・やり直し（すべての編集が対象。その後で変えられた所はぶつかりとして止める）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { readLog, readLocks } from '../src/project/oplog.ts';
import { revert } from '../src/core/revert.ts';
import { cmdUndo } from '../src/cli/ages.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const human = { who: 'yamamoto', kind: 'human' as const, win: 'inspector' };
const other = { who: 'sato', kind: 'human' as const, win: 'inspector' };
const keeper = { who: 'yamamoto', kind: 'human' as const, win: 'lock-manager' };
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}
const speed = (p: Project) => p.docs.scenes.get('main')!.entities.find((e) => e.id === 'player')!.components.Player.speed;

test('3つを見比べて戻す: その後に変わった所はそのまま、同じ所が変わっていればぶつかり', () => {
  const before = { entities: [{ id: 'a', components: { P: { x: 1, y: 1 } } }, { id: 'b', components: {} }] };
  const after = { entities: [{ id: 'a', components: { P: { x: 2, y: 1 } } }, { id: 'b', components: {} }] };
  const current = { entities: [{ id: 'c', components: {} }, { id: 'a', components: { P: { x: 2, y: 5 } } }, { id: 'b', components: {} }] };
  assert.deepEqual(revert(current, after, before, 'scene:main'), { value: { entities: [{ id: 'c', components: {} }, { id: 'a', components: { P: { x: 1, y: 5 } } }, { id: 'b', components: {} }] }, conflicts: [] });
  const clash = { entities: [{ id: 'a', components: { P: { x: 3, y: 1 } } }, { id: 'b', components: {} }] };
  assert.deepEqual(revert(clash, after, before, 'scene:main').conflicts, ['main#a.P.x（2 にした後で 3 に変わっています）']);
  // 消した物を戻すと、前の場所に戻る。並べ替えも戻る
  const removed = { entities: [{ id: 'b', components: {} }] };
  assert.deepEqual((revert(removed, removed, before, 'scene:main').value as typeof before).entities.map((e) => e.id), ['a', 'b']);
  const moved = { rows: [{ id: 'y' }, { id: 'x' }] };
  assert.deepEqual(revert(moved, moved, { rows: [{ id: 'x' }, { id: 'y' }] }, '$t').value, { rows: [{ id: 'x' }, { id: 'y' }] });
});

test('人の編集を元に戻す・やり直す。新しい編集をすると、やり直しの列は消える', async () => {
  const p = await Project.load(await fresh());
  await p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 6 }], human);
  await p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 7 }], human);
  assert.equal((await p.undoState(human)).undo?.label, 'main#player.Player.speed 6→7');
  await p.undo(human);
  assert.equal(speed(p), 6);
  await p.undo(human);
  assert.equal(speed(p), 4.5);
  await assert.rejects(p.undo(human), /元に戻せる編集はありません/);
  await p.undo(human, { redo: true });
  assert.equal(speed(p), 6);
  assert.equal((await p.undoState(human)).redo?.label, 'main#player.Player.speed 6→7', 'やり直しは、戻した順の逆');
  await p.apply([{ op: 'set', path: 'main#player.Player.fireInterval', value: 4 }], human);
  assert.equal((await p.undoState(human)).redo, undefined, '新しい編集でやり直しの列は消える');
  // ファイルにも残り、読み直しても同じ。操作ログにも「元に戻す」と残る
  assert.equal(speed(await Project.load(p.dir)), 6);
  assert.ok((await readLog(p.dir)).some((e) => e.op === 'undo' && e.path === 'main#player.Player.speed' && e.to === 6));
});

test('その後で別の人が同じ値を変えていたら、戻さずに知らせる。別の値なら戻せる', async () => {
  const p = await Project.load(await fresh());
  await p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 6 }], human);
  await p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 8 }], other);
  await assert.rejects(p.undo(human), /元に戻せません。その後で変えられています: main#player\.Player\.speed（6 にした後で 8 に変わっています）/);
  assert.equal(speed(p), 8);
  await p.apply([{ op: 'set', path: 'main#player.Player.fireInterval', value: 4 }], human);
  await p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 9 }], other);
  await p.undo(human);
  assert.equal(p.docs.scenes.get('main')!.entities.find((e) => e.id === 'player')!.components.Player.fireInterval, 8, '別の値はそのまま戻せる');
  assert.equal(speed(p), 9);
});

test('物・行の削除、シーンの名前、アセットの移動と削除、画像の切り方も元に戻せる', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'removeEntity', scene: 'main', id: 'hud' }], ai);
  await p.undo(ai);
  assert.deepEqual(p.docs.scenes.get('main')!.entities.map((e) => e.id).slice(0, 4), ['player', 'spawner', 'hud', 'camera'], '前の場所に戻る');
  await p.apply([{ op: 'addRow', table: 'enemies', row: { id: 'boss', hp: 20 } }, { op: 'moveRow', table: 'enemies', id: 'boss', to: 0 }], ai);
  await p.undo(ai);
  assert.deepEqual(p.docs.tables.get('enemies')!.rows.map((r) => r.id), ['basic', 'fast', 'tough']);
  await p.apply([{ op: 'renameScene', name: 'main', to: 'stage1' }], human);
  await p.undo(human);
  assert.ok(existsSync(join(dir, 'scenes/main.scene.json')) && !existsSync(join(dir, 'scenes/stage1.scene.json')));
  assert.equal(p.config.startScene, 'main');
  await p.apply([{ op: 'moveAsset', from: 'assets/sounds', to: 'assets/se' }], ai);
  await p.undo(ai);
  assert.ok(existsSync(join(dir, 'assets/sounds/hit.wav')));
  assert.equal(p.docs.prefabs.get('se_hit')!.components.Sound.clip, 'assets/sounds/hit.wav');
  // 消したファイルは控えから戻る（切り方も）
  await cp(join(dir, 'assets/kenney-pixel-shmup/ships.png'), join(dir, 'assets/spare.png'));
  await writeFile(join(dir, 'assets/spare.sheet.json'), '{ "frame": [32, 32] }\n');
  const q = await Project.load(dir);
  await q.apply([{ op: 'removeAsset', path: 'assets/spare.png' }], ai);
  assert.ok(!existsSync(join(dir, 'assets/spare.png')));
  await q.undo(ai);
  assert.ok(existsSync(join(dir, 'assets/spare.png')) && existsSync(join(dir, 'assets/spare.sheet.json')));
  await q.undo(ai, { redo: true });
  assert.ok(!existsSync(join(dir, 'assets/spare.png')), 'やり直すと、また消える');
  const before = JSON.stringify(q.docs.sheets.get('assets/kenney-pixel-shmup/ships.png'));
  await q.apply([{ op: 'setFrame', image: 'assets/kenney-pixel-shmup/ships.png', frame: 0, name: 'hero' }], ai);
  await q.undo(ai);
  assert.equal(JSON.stringify(q.docs.sheets.get('assets/kenney-pixel-shmup/ships.png')), before);
});

test('取り込みも元に戻せる（足したものは消え、差し替えたものは前の中身に）', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  const hit = await readFile(join(dir, 'assets/sounds/hit.wav'));
  const shot = await readFile(join(dir, 'assets/sounds/shot.wav'));
  await p.upload('assets/sounds/new.wav', shot, human);
  await p.upload('assets/sounds/hit.wav', shot, human);
  await p.undo(human);
  assert.deepEqual(await readFile(join(dir, 'assets/sounds/hit.wav')), hit, '差し替えは前の中身に');
  await p.undo(human);
  assert.ok(!existsSync(join(dir, 'assets/sounds/new.wav')), '足したものは消える');
  await p.undo(human, { redo: true });
  assert.deepEqual(await readFile(join(dir, 'assets/sounds/new.wav')), shot);
  await p.apply([{ op: 'set', path: '@se_hit.Sound.clip', value: 'assets/sounds/new.wav' }], human);
  await assert.rejects(p.undo(human, { tx: (await p.journal.read()).filter((r) => r.redoOf).at(-1)!.id }), /使われているので、取り込みを戻せません/);
});

test('ロック: ロックされた値に関わる編集は、AI も人のエディタも戻せない。AI は人が調整した値を戻すとき確認が要る', async () => {
  const p = await Project.load(await fresh());
  await p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 6 }], human);
  await p.lock(['main#player.Player.speed'], keeper);
  await assert.rejects(p.undo(human), /🔒 ロックされた値に関わるので、元に戻せません: main#player\.Player\.speed。変えるならロックマネージャーで/);
  // AI が自分の編集を戻すのは、人が前に調整した値でも確認は要らない（前の値に戻るだけ）
  await p.apply([{ op: 'set', path: 'main#player.Player.fireInterval', value: 4 }], human);
  await p.apply([{ op: 'set', path: 'main#player.Player.fireInterval', value: 2 }], ai, { force: true });
  assert.match(await cmdUndo(p.dir, {}), /元に戻した: main#player\.Player\.fireInterval 4→2/);
  // AI が人の編集を戻すときは確認が要る
  const tx = (await readLog(p.dir)).find((e) => e.path === 'main#player.Player.fireInterval' && e.who === 'yamamoto')!.tx!;
  const q = await Project.load(p.dir);
  await assert.rejects(q.undo(ai, { tx }), /人が調整した値に触れます: main#player\.Player\.fireInterval/);
  await q.undo(ai, { tx, force: true });
  assert.equal((await readLocks(p.dir))['main#player.Player.speed'].value, 6, 'ロックはそのまま');
});

test('エディタのテキストでの書き換えも、元に戻せる', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  const file = p.scenePath('main');
  await writeFile(file, (await readFile(file, 'utf8')).replace('"fireInterval": 8', '"fireInterval": 3'));
  await p.humanTextEdit({ who: 'yamamoto', kind: 'human', win: 'text' });
  await p.undo({ who: 'yamamoto', kind: 'human', win: 'inspector' });
  assert.match(await readFile(file, 'utf8'), /"fireInterval": 8/);
});

test('操作ログから、AI の編集を選んで人が戻せる', async () => {
  const p = await Project.load(await fresh());
  await p.apply([{ op: 'set', path: '@enemy.Health.hp', value: 9 }], ai);
  await p.apply([{ op: 'set', path: 'main#player.Player.speed', value: 6 }], human);
  const tx = (await readLog(p.dir)).find((e) => e.path === '@enemy.Health.hp')!.tx!;
  await p.undo(human, { tx });
  assert.equal(p.docs.prefabs.get('enemy')!.components.Health.hp, 2);
  assert.equal(speed(p), 6, '人の編集はそのまま');
  await assert.rejects(p.undo(human, { tx }), /もう戻してあります/);
});
