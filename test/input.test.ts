// 段階2-5: 入力（操作の名前・キーコンフィグ・アナログ・マウス・記録と再生）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { Input, InputPlayback, InputRecorder, keysToEvents, type ActionDef, type FrameInput } from '../src/core/input.ts';
import { readGamepads } from '../src/input/devices.ts';
import { cmdRun } from '../src/cli/ages.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));

const def = (o: Partial<ActionDef>): ActionDef => ({ kind: 'button', keys: [], negative: [], analog: [], deadzone: 0.2, ...o });
const ACTIONS = new Map<string, ActionDef>([
  ['fire', def({ keys: ['KeyZ', 'Pad.A'] })],
  ['jump', def({ keys: ['Space'], analog: ['Pad.RT'] })],
  ['move_x', def({ kind: 'axis', keys: ['ArrowRight'], negative: ['ArrowLeft'], analog: ['Pad.LX'] })],
]);
const input = () => { const i = new Input(); i.setActions(ACTIONS); return i; };

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

test('操作の名前で読める。押した瞬間・離した瞬間も、ボタンの名前でも読める', () => {
  const i = input();
  i.setFrame(['KeyZ']);
  assert.ok(i.isDown('fire') && i.pressed('fire') && !i.released('fire'));
  assert.ok(i.isDown('KeyZ') && i.pressed('KeyZ'));
  i.setFrame(['KeyZ', 'Pad.A']);
  assert.ok(i.isDown('fire') && !i.pressed('fire'), '別の割り当てを足しても「押した瞬間」は増えない');
  i.setFrame(['Pad.A']);
  assert.ok(i.isDown('fire') && !i.released('fire'));
  i.setFrame([]);
  assert.ok(!i.isDown('fire') && i.released('fire'));
  assert.throws(() => i.value('fyre'), /操作 fyre はありません.*もしかして: fire/);
});

test('キーコンフィグ: スクリプトから割り当てを変え、戻し、セーブ用に書き出して読み戻せる', () => {
  const i = input();
  i.bind('fire', { keys: ['KeyX'] });
  i.setFrame(['KeyZ']);
  assert.equal(i.isDown('fire'), false, '変えた後は古いキーでは撃たない');
  i.setFrame(['KeyX']);
  assert.equal(i.isDown('fire'), true);
  assert.deepEqual(i.bindings('fire').keys, ['KeyX']);
  assert.deepEqual(i.bindings('fire').analog, [], '渡していない項目は表の通り');
  assert.deepEqual(i.usedBy('KeyX'), ['fire']);
  assert.deepEqual(i.usedBy('KeyZ'), []);
  const saved = i.exportBindings();
  assert.deepEqual(saved, { fire: { keys: ['KeyX'] } }, '表の通りのものは書き出さない');
  i.resetBindings();
  assert.deepEqual(i.bindings('fire').keys, ['KeyZ', 'Pad.A']);
  i.importBindings({ ...saved, removed_action: { keys: ['KeyQ'] } });
  assert.deepEqual(i.bindings('fire').keys, ['KeyX'], 'ない操作は無視して読み戻す');
  i.resetBindings('fire');
  assert.deepEqual(i.exportBindings(), {});
  assert.throws(() => i.bind('fier', { keys: ['KeyX'] }), /もしかして: fire/);
  // 書き出したものを変えても、中の割り当ては変わらない
  i.bind('jump', { keys: ['KeyJ'] });
  const out = i.exportBindings();
  out.jump.keys!.push('KeyK');
  assert.deepEqual(i.bindings('jump').keys, ['KeyJ']);
});

test('「押したボタンを割り当てる」用に、このフレームで押されたボタンがわかる。人向けの名前もある', () => {
  const i = input();
  i.setFrame(['KeyA']);
  i.setFrame(['KeyA', 'Pad.B']);
  assert.equal(i.lastPressed(), 'Pad.B');
  i.setFrame(['KeyA', 'Pad.B']);
  assert.equal(i.lastPressed(), null);
  assert.equal(i.label('ArrowLeft'), '←');
  assert.equal(i.label('KeyZ'), 'Z');
  assert.equal(i.label('Mouse0'), 'マウス左');
  assert.equal(i.label('Pad2.Up'), 'パッド2 十字↑');
});

test('アナログ: 遊び（deadzone）より小さい傾きは 0。キーとスティックは大きいほう。トリガーはボタンにもなる', () => {
  const i = input();
  const f = (buttons: string[], axes: Record<string, number>): FrameInput => ({ buttons, axes });
  i.setFrame(f([], { 'Pad.LX': 0.1 }));
  assert.equal(i.value('move_x'), 0);
  assert.equal(i.isDown('move_x'), false);
  i.setFrame(f([], { 'Pad.LX': -0.5 }));
  assert.equal(i.value('move_x'), -0.5);
  assert.ok(i.pressed('move_x'), 'スティックを倒した瞬間も「押した瞬間」');
  assert.equal(i.raw('Pad.LX'), -0.5);
  i.setFrame(f(['ArrowRight'], { 'Pad.LX': -0.5 }));
  assert.equal(i.value('move_x'), 1, 'キー（1）のほうが大きい');
  i.setFrame(f(['ArrowLeft', 'ArrowRight'], {}));
  assert.equal(i.value('move_x'), 0, '両方押したら打ち消し合う');
  i.setFrame(f([], { 'Pad.RT': 0.7 }));
  assert.equal(i.value('jump'), 1);
  assert.ok(i.pressed('jump'));
  i.setFrame(f([], { 'Pad.RT': 0.1 }));
  assert.ok(i.released('jump'));
});

test('記録と再生: ボタン・軸・マウスの位置・ホイール・タッチがそのまま戻る', () => {
  const frames: FrameInput[] = [
    { buttons: [], axes: {}, pointer: null },
    { buttons: ['Mouse0'], axes: { 'Pad.LX': 0.5 }, pointer: { x: 10, y: 20 }, wheel: 1 },
    { buttons: ['Mouse0'], axes: { 'Pad.LX': 0.5 }, pointer: { x: 10, y: 20 } },
    { buttons: ['Touch'], axes: { 'Pad.LX': -1 }, pointer: { x: 30, y: 40 }, touches: [{ id: 7, x: 30, y: 40 }] },
    { buttons: [], axes: {}, pointer: null, wheel: -2 },
  ];
  const rec = new InputRecorder();
  frames.forEach((f, n) => rec.record(n, f));
  assert.equal(rec.events.some((e) => e.f === 2), false, '何も変わらないフレームは記録しない');
  const play = new InputPlayback(JSON.parse(JSON.stringify(rec.events)));
  frames.forEach((f, n) => {
    const got = play.at(n);
    assert.deepEqual([...got.buttons].sort(), [...f.buttons].sort(), `フレーム ${n} のボタン`);
    assert.deepEqual(got.axes, f.axes, `フレーム ${n} の軸`);
    assert.deepEqual(got.pointer, f.pointer, `フレーム ${n} の位置`);
    assert.equal(got.wheel, f.wheel ?? 0, `フレーム ${n} のホイール`);
    assert.deepEqual(got.touches, f.touches ?? [], `フレーム ${n} のタッチ`);
  });
});

test('入力の指定（--keys）は操作の名前・軸・位置・ホイールで書ける。間違いは候補付き', () => {
  const ev = keysToEvents('0-10:@fire+@move_x=-1;5-8:@move_x=0.5+Pad.LY=-1;3:ptr=100,50+wheel=2', ACTIONS);
  const play = new InputPlayback(ev);
  const at = (f: number) => { for (let i = 0; i < f; i++) play.at(i); return play.at(f); };
  const f3 = at(3);
  assert.deepEqual([...f3.buttons].sort(), ['ArrowLeft', 'KeyZ'], '@fire は最初のキー、@move_x=-1 は − の向きの最初のキー');
  assert.deepEqual(f3.pointer, { x: 100, y: 50 });
  assert.equal(f3.wheel, 2);
  const f5 = play.at(4) && play.at(5);
  assert.deepEqual(f5.axes, { 'Pad.LX': 0.5, 'Pad.LY': -1 }, '@move_x=0.5 はアナログの軸');
  assert.equal(f5.wheel, 0, 'ホイールはそのフレームだけ');
  for (let i = 6; i < 8; i++) play.at(i);
  assert.deepEqual(play.at(8).axes, {}, '終わりのフレームで 0 に戻る');
  for (let i = 9; i < 10; i++) play.at(i);
  assert.deepEqual([...play.at(10).buttons], [], '終わりのフレームで離す');
  assert.throws(() => keysToEvents('0-10:@fyre', ACTIONS), /操作 fyre はありません。もしかして: fire/);
  assert.throws(() => keysToEvents('0-10:@fire=0.5', ACTIONS), /アナログの軸が割り当てられていません/);
  assert.throws(() => keysToEvents('0-10:ptr=1', ACTIONS), /ptr=横,縦/);
});

test('ゲームパッドは Pad.A などの名前と軸の値になる。わずかなぶれは 0、2台目は Pad2', () => {
  const btn = (pressed: boolean, value = pressed ? 1 : 0) => ({ pressed, value, touched: pressed });
  const pad = (axes: number[], pressed: number[], rt = 0) => ({
    connected: true, mapping: 'standard', axes,
    buttons: Array.from({ length: 17 }, (_, i) => (i === 7 ? btn(rt > 0.5, rt) : btn(pressed.includes(i)))),
  }) as unknown as Gamepad;
  const buttons = new Set<string>(), axes: Record<string, number> = {};
  readGamepads([null, pad([0.02, -0.9, 0, 0], [0, 14], 0.3), pad([0.8, 0, 0, 0], [1])], buttons, axes);
  assert.deepEqual([...buttons].sort(), ['Pad.A', 'Pad.Left', 'Pad.LStickUp', 'Pad2.B', 'Pad2.LStickRight'].sort());
  assert.equal(axes['Pad.LX'], undefined, 'ぶれは記録しない');
  assert.equal(axes['Pad.LY'], -0.8984375, '1/256 にそろえる');
  assert.equal(axes['Pad.RT'], 0.30078125);
  assert.equal(axes['Pad2.LX'], 0.80078125);
});

test('サンプル: 操作の名前で動き、割り当ての誤りは検証で候補付きで見つかる', async () => {
  const dir = await fresh();
  const out = await cmdRun(dir, { frames: '200', keys: '0-200:@fire+@move_x=-1', watch: 'player.Transform.x' });
  assert.match(out, /se_shot×\d+/, '@fire で撃つ');
  assert.match(out, /player\.Transform\.x: 240 → \d+/);
  const x = Number(out.match(/player\.Transform\.x: 240 → (\d+)/)![1]);
  assert.ok(x < 240, '左へ動く');
  // ゲームパッドの軸でも同じように動く（遊びより小さければ動かない）
  const small = await cmdRun(dir, { frames: '60', keys: '0-60:Pad.LX=0.1', watch: 'player.Transform.x' });
  assert.match(small, /player\.Transform\.x: 240 → 240/);
  const file = join(dir, 'data/actions.table.json');
  await writeFile(file, (await readFile(file, 'utf8')).replace('"KeyZ"', '"KeyZZ"').replace('"Pad.LX"', '"Pad.LXX"'));
  const p = await Project.load(dir);
  const issues = p.validate();
  assert.ok(issues.some((e) => /\$actions\.fire\.keys\[0\]="KeyZZ": ボタンの名前ではありません。もしかして: KeyZ/.test(e)), issues.join('\n'));
  assert.ok(issues.some((e) => /analog\[0\]="Pad.LXX": 軸の名前ではありません。もしかして: Pad.LX/.test(e)), issues.join('\n'));
});

test('マウスの位置をワールドの座標にできる（カメラの位置・拡大込み）', async () => {
  const p = await Project.load(await fresh());
  const g = p.newGame();
  g.step({ buttons: [], pointer: { x: 240, y: 320 } });
  const cam = g.world.get('camera')!;
  const [x, y] = g.ctx.pointerWorld()!;
  assert.ok(Math.abs(x - cam.c.Transform.x) < 1e-6 && Math.abs(y - cam.c.Transform.y) < 1e-6, '画面の真ん中 = カメラの位置');
  cam.c.Camera.zoom = 2;
  g.step({ buttons: [], pointer: { x: 0, y: 0 } });
  const [x2] = g.ctx.pointerWorld('camera')!;
  assert.ok(Math.abs(x2 - (cam.c.Transform.x - 120)) < 1e-6, '2倍に拡大すると、左端は半分の距離');
  g.step({ buttons: [], pointer: null });
  assert.equal(g.ctx.pointerWorld(), null);
  assert.throws(() => g.ctx.pointerWorld('camra'), /カメラ camra がありません.*もしかして: camera/);
});

test('同じ記録なら、軸やマウスを含めても毎回同じ結果になる', async () => {
  const p = await Project.load(await fresh());
  const spec = '0-300:@fire;20-120:Pad.LX=-0.7;120-200:@move_y=-1;40:ptr=100,100;50:wheel=3';
  const run = () => {
    const g = p.newGame();
    const play = new InputPlayback(keysToEvents(spec, new Map(p.registry.tableView('actions').rows.map((r) => [r.id, r as unknown as ActionDef]))));
    for (let i = 0; i < 300; i++) g.step(play.at(g.frame));
    return g.hash();
  };
  assert.equal(run(), run());
});
