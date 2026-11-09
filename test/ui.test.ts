// 段階2-11: UI の土台（画面に固定する置き方・並べ方・ボタン・ゲージ・ダイアログ）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, defineSystem } from '../src/core/registry.ts';
import { Game, type Ctx } from '../src/core/game.ts';
import type { ProjectConfig, SceneDoc } from '../src/core/docs.ts';
import { layoutUI } from '../src/core/ui.ts';
import type { FrameInput } from '../src/core/input.ts';
import { cmdRun, cmdUi } from '../src/cli/ages.ts';
import { Project } from '../src/project/project.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const CONFIG: ProjectConfig = { name: 't', fps: 60, seed: 1, view: { width: 400, height: 300, background: '#000' }, startScene: 'a', game: 'game/index.ts' };
type C = Record<string, Record<string, unknown>>;
const ent = (id: string, components: C) => ({ id, name: id, components });

function game(entities: ReturnType<typeof ent>[], log: string[] = []) {
  const reg = Registry.from({
    components: [],
    systems: [defineSystem({ name: 'watch', desc: '', update: (c: Ctx) => {
      for (const e of c.world.entities.values()) if (c.ui.clicked(e.id)) log.push(`click ${e.id}@${c.frame}`);
      if (c.input.pressed('Mouse0')) log.push(`game Mouse0@${c.frame}`);
    } })],
  });
  const scene: SceneDoc = { name: 'a', entities };
  reg.scenes.set('a', scene);
  return new Game(reg, CONFIG, scene);
}
const at = (x: number, y: number, ...buttons: string[]): FrameInput => ({ buttons, pointer: { x, y } });
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };
async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

test('置き方: 画面（または親）のどこに合わせるか。自分の同じ所がそこに来る', () => {
  const g = game([
    ent('tl', { UI: { anchor: 'topLeft', x: 10, y: 5, w: 50, h: 20 } }),
    ent('br', { UI: { anchor: 'bottomRight', x: -10, y: -10, w: 50, h: 20 } }),
    ent('c', { UI: { w: 100, h: 60 } }),
    ent('inC', { UI: { anchor: 'top', parent: 'c', y: 4, w: 20, h: 10 } }),
    ent('hidden', { UI: { visible: false, w: 10, h: 10 } }),
    ent('inHidden', { UI: { parent: 'hidden' } }),
    ent('loop1', { UI: { parent: 'loop2' } }),
    ent('loop2', { UI: { parent: 'loop1' } }),
  ]);
  const r = layoutUI(g.world, 400, 300);
  assert.deepEqual(r.get('tl'), { x: 10, y: 5, w: 50, h: 20, visible: true, parent: null });
  assert.deepEqual([r.get('br')!.x, r.get('br')!.y], [400 - 10 - 50, 300 - 10 - 20]);
  assert.deepEqual([r.get('c')!.x, r.get('c')!.y], [150, 120]);
  assert.deepEqual([r.get('inC')!.x, r.get('inC')!.y], [190, 124]);
  assert.equal(r.get('inHidden')!.visible, false, '親が隠れると子も隠れる');
  assert.ok(r.has('loop1') && r.has('loop2'), '親が輪になっていても止まらない');
});

test('並べ方: Layout の子を order の順に、間・余白・揃えで並べる。隠れた子は詰める', () => {
  const g = game([
    ent('menu', { UI: { w: 200, h: 200 }, Layout: { gap: 10, padding: 20, align: 'center', justify: 'start' } }),
    ent('b', { UI: { parent: 'menu', order: 2, w: 100, h: 30 } }),
    ent('a', { UI: { parent: 'menu', order: 1, w: 160, h: 30 } }),
    ent('off', { UI: { parent: 'menu', order: 0, w: 100, h: 30, visible: false } }),
    ent('row', { UI: { anchor: 'bottom', w: 300, h: 40 }, Layout: { dir: 'horizontal', gap: 0, justify: 'center', align: 'end' } }),
    ent('r1', { UI: { parent: 'row', w: 50, h: 20 } }),
    ent('r2', { UI: { parent: 'row', w: 50, h: 30 } }),
  ]);
  const r = layoutUI(g.world, 400, 300);
  // menu は (100,50)。a が先（order 1）、隠れた off は数えない
  assert.deepEqual([r.get('a')!.x, r.get('a')!.y], [100 + 20, 50 + 20]);
  assert.deepEqual([r.get('b')!.x, r.get('b')!.y], [100 + 50, 50 + 20 + 30 + 10]);
  assert.equal(r.get('off')!.visible, false);
  // row は (50,260)。中央に寄せ、下で揃える
  assert.deepEqual([r.get('r1')!.x, r.get('r1')!.y, r.get('r2')!.x, r.get('r2')!.y], [150, 280, 200, 270]);
});

test('ボタン: 上で押して離すと clicked。ボタンの上で押したマウスはゲームに渡らない。位置は Transform にも入る', () => {
  const log: string[] = [];
  const g = game([ent('ok', { Transform: {}, UI: { w: 100, h: 40 }, Shape: {}, Button: {} })], log);
  g.step(at(200, 150));
  assert.equal(g.world.get('ok')!.c.Button.state, 'hover');
  assert.deepEqual([g.world.get('ok')!.c.Transform.x, g.world.get('ok')!.c.Transform.y], [200, 150]);
  g.step(at(200, 150, 'Mouse0'));
  assert.equal(g.world.get('ok')!.c.Button.state, 'pressed');
  g.step(at(200, 150));
  // ボタンの外で押すとゲームへ。押したまま外で離すと押されない
  g.step(at(10, 10, 'Mouse0'));
  g.step(at(10, 10));
  g.step(at(200, 150, 'Mouse0'));
  g.step(at(10, 10));
  assert.deepEqual(log, ['click ok@2', 'game Mouse0@3']);
  assert.equal(g.uiCounts.get('ok'), 1);
  assert.equal(g.counts.get('ui.click'), 1);
});

test('キーボード・パッド: 矢印で合わせて Enter（ui_confirm）。押せないボタンは飛ばす。ダイアログの外は押せない', () => {
  const log: string[] = [];
  const g = game([
    ent('menu', { UI: { w: 200, h: 200 }, Layout: { gap: 10 } }),
    ent('start', { UI: { parent: 'menu', w: 100, h: 30 }, Button: {} }),
    ent('locked', { UI: { parent: 'menu', w: 100, h: 30 }, Button: { enabled: false } }),
    ent('quit', { UI: { parent: 'menu', w: 100, h: 30 }, Button: {} }),
  ], log);
  g.step({ buttons: ['ArrowDown'] });
  assert.equal(g.ctx.ui.focused(), 'start', '最初は左上に近い物');
  g.step({ buttons: [] });
  g.step({ buttons: ['ArrowDown'] });
  assert.equal(g.ctx.ui.focused(), 'quit', '押せないボタンは飛ばす');
  assert.equal(g.world.get('quit')!.c.Button.state, 'focus');
  assert.equal(g.world.get('locked')!.c.Button.state, 'disabled');
  g.step({ buttons: ['Enter'] });
  assert.deepEqual(log, ['click quit@3']);
  // ダイアログ（modal）が出ている間は、その中だけ押せる。外で押してもゲームには渡らない
  const log2: string[] = [];
  const g2 = game([
    ent('play', { UI: { anchor: 'topLeft', w: 100, h: 40 }, Button: {} }),
    ent('dialog', { UI: { w: 200, h: 100, modal: true } }),
    ent('yes', { UI: { parent: 'dialog', w: 80, h: 30 }, Button: {} }),
  ], log2);
  g2.step(at(50, 20, 'Mouse0'));
  g2.step(at(50, 20));
  g2.step(at(200, 150, 'Mouse0'));
  g2.step(at(200, 150));
  assert.deepEqual(log2, ['click yes@3']);
  g2.world.get('dialog')!.c.UI.visible = false;
  g2.step(at(50, 20, 'Mouse0'));
  g2.step(at(50, 20));
  assert.deepEqual(log2, ['click yes@3', 'click play@5']);
  assert.throws(() => g2.ctx.ui.focus('nope'), /nope は UI の付いた物ではありません/);
});

test('ゲージ: drag ならスライダー（押した位置・左右で値が変わり、刻みにそろう）', () => {
  const g = game([ent('vol', { UI: { anchor: 'topLeft', w: 100, h: 10 }, Gauge: { value: 0.5, max: 1, drag: true, step: 0.1 } })]);
  g.step(at(73, 5, 'Mouse0'));
  assert.equal(g.world.get('vol')!.c.Gauge.value, 0.7);
  assert.ok(g.ctx.ui.changed('vol'));
  g.step(at(200, 5, 'Mouse0'));
  assert.equal(g.world.get('vol')!.c.Gauge.value, 1, '押したまま外へ出ても最大で止まる');
  g.step(at(200, 5));
  g.ctx.ui.focus('vol');
  g.step({ buttons: ['ArrowLeft'] });
  assert.equal(g.world.get('vol')!.c.Gauge.value, 0.9);
  g.step({ buttons: [] });
  assert.ok(!g.ctx.ui.changed('vol'));
});

test('同じ入力なら同じ結果（UI の状態も hash に入る）。ages run の click=ボタンのID と --until click:', async () => {
  const run = () => {
    const g = game([ent('ok', { UI: { w: 100, h: 40 }, Button: {} })]);
    g.step(at(200, 150, 'Mouse0'));
    return g.hash();
  };
  assert.equal(run(), run());
  const g = game([ent('ok', { UI: { w: 100, h: 40 }, Button: {} })]);
  g.step(at(10, 10));
  assert.notEqual(g.hash(), run());
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  const out = await cmdRun(dir, { scene: 'result', frames: '200', keys: '40:click=retyr;50:click=retry', until: 'click:retry' });
  assert.match(out, /停止:click:retry @f51/);
  assert.match(out, /⚠ f40 click=retyr: UI の付いた物 retyr がありません。もしかして: retry/);
  assert.match(out, /ui: 押されたボタン retry×1/);
  // 座標でも押せる（1フレームだけ押す）
  assert.match(await cmdRun(dir, { scene: 'result', frames: '100', keys: '60:click=240,440' }), /scenes: result@0 → main@/);
});

test('隣に付ける（beside）: 相手の右・左・下・上に接して置き、揃える。相手が動けば一緒に動く。輪になっても止まらない', () => {
  const g = game([
    ent('gauge', { UI: { anchor: 'topRight', x: -10, y: 10, w: 100, h: 10 } }),
    ent('label', { UI: { beside: 'gauge', side: 'left', gap: 6, align: 'center', w: 24, h: 16 } }),
    ent('under', { UI: { beside: 'gauge', side: 'below', gap: 0, align: 'end', w: 40, h: 8 } }),
    ent('under2', { UI: { beside: 'under', side: 'below', w: 40, h: 8, x: 2 } }),
    ent('a', { UI: { beside: 'b', w: 10, h: 10 } }),
    ent('b', { UI: { beside: 'a', w: 10, h: 10 } }),
  ]);
  let r = layoutUI(g.world, 400, 300);
  assert.deepEqual([r.get('gauge')!.x, r.get('gauge')!.y], [290, 10]);
  assert.deepEqual([r.get('label')!.x, r.get('label')!.y], [290 - 6 - 24, 10 + (10 - 16) / 2]);
  assert.deepEqual([r.get('under')!.x, r.get('under')!.y], [290 + 100 - 40, 20], '下に接して、右端を揃える');
  assert.deepEqual([r.get('under2')!.x, r.get('under2')!.y], [352, 28], 'x・y は最後に足すずれ');
  assert.ok(r.has('a') && r.has('b'));
  g.world.get('gauge')!.c.UI.y = 50;
  r = layoutUI(g.world, 400, 300);
  assert.equal(r.get('under2')!.y, 68, '相手が動けば一緒に動く');
});

test('レール: dockUI で画面の端・角に付け、attachUI で別の UI の隣に接して置く。ages ui で配置・重なり・はみ出しを文字で見る', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([
    { op: 'addEntity', scene: 'main', entity: { id: 'coins', name: 'Coins', components: { UI: { anchor: 'center', w: 80, h: 20 } } } },
    { op: 'addEntity', scene: 'main', entity: { id: 'over', name: 'Over', components: { UI: { anchor: 'topRight', x: -20, y: 10, w: 60, h: 10 } } } },
    { op: 'addEntity', scene: 'main', entity: { id: 'out', name: 'Out', components: { UI: { anchor: 'left', x: -30, w: 60, h: 10 } } } },
  ], ai);
  await p.apply([{ op: 'dockUI', target: 'main#coins', edge: 'bottomRight', margin: 8 }], ai);
  assert.deepEqual(p.docs.scenes.get('main')!.entities.find((e) => e.id === 'coins')!.components.UI, { anchor: 'bottomRight', w: 80, h: 20, x: -8, y: -8 });
  await p.apply([{ op: 'attachUI', target: 'main#coins', to: 'hpGauge', side: 'below', gap: 4, align: 'end' }], ai);
  const out = await cmdUi(dir, 'main');
  assert.match(out, /^coins 388,26 80x20 ← hpGauge の下に間 4・端揃え$/m, 'ずれ（x・y）は 0 に戻る');
  assert.match(out, /⚠ 重なっている: hpGauge と over/);
  assert.match(out, /⚠ 画面からはみ出している: out/);
  // dockUI で付け直すと、隣に付けたのは外れる
  await p.apply([{ op: 'dockUI', target: 'main#coins', edge: 'top' }], ai);
  assert.equal(p.docs.scenes.get('main')!.entities.find((e) => e.id === 'coins')!.components.UI.beside, null);
  await assert.rejects(p.apply([{ op: 'dockUI', target: 'main#coins', edge: 'topRigt' }], ai), /もしかして: topRight/);
  await assert.rejects(p.apply([{ op: 'attachUI', target: 'main#coins', to: 'hpGauje' }], ai), /hpGauje はありません。もしかして: hpGauge/);
  await assert.rejects(p.apply([{ op: 'attachUI', target: 'main#coins', to: 'player' }], ai), /player に UI が付いていません/);
  await p.apply([{ op: 'attachUI', target: 'main#over', to: 'coins' }], ai);
  await assert.rejects(p.apply([{ op: 'attachUI', target: 'main#coins', to: 'over' }], ai), /輪になります/);
  await assert.rejects(p.apply([{ op: 'set', path: 'main#coins.UI.beside', value: 'over' }], ai), /輪になっています/);
});
