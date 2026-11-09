// 段階2-9: 演出の基本（トゥイーン・パーティクル）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { EASES, EASE_NAMES } from '../src/core/ease.ts';
import { lerpValue } from '../src/core/tween.ts';
import type { ParticleCmd } from '../src/core/particles.ts';
import { ParticleSim } from '../src/render/particles.ts';
import { collectDrawables } from '../src/render/geom.ts';
import { cmdRun, cmdMap } from '../src/cli/ages.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

test('イージング: どれも 0 で 0、1 で 1。outBack は行き過ぎて戻る', () => {
  for (const n of EASE_NAMES) {
    assert.ok(Math.abs(EASES[n](0)) < 1e-9, `${n}(0)`);
    assert.ok(Math.abs(EASES[n](1) - 1) < 1e-9, `${n}(1)`);
  }
  assert.ok(EASES.outBack(0.7) > 1);
  assert.equal(EASES.step(0.99), 0);
  assert.equal(lerpValue('#000000', '#ffffff', 0.5), '#808080');
  assert.deepEqual(lerpValue([0, 10], [10, 20], 0.5), [5, 15]);
});

test('トゥイーン: フレームで数えて進み、ちょうど終わりの値になる。くり返し・行って戻る・相対の値', async () => {
  const p = await Project.load(await fresh());
  const g = p.newGame();
  g.step();
  const x0 = g.world.get('hud')!.c.Transform.x;
  // 60fps で 0.1秒 = 6フレーム
  g.ctx.tween('hud', { 'Transform.sx': 3, 'Transform.x': '+60' }, { time: 0.1, ease: 'linear' });
  const sx: number[] = [];
  for (let i = 0; i < 6; i++) { g.step(); sx.push(Number(g.world.get('hud')!.c.Transform.sx.toFixed(3))); }
  assert.deepEqual(sx, [1.333, 1.667, 2, 2.333, 2.667, 3]);
  assert.equal(g.world.get('hud')!.c.Transform.x, x0 + 60);
  assert.equal(g.tweens.length, 0, '終わったら消える');
  // 行って戻るを1回くり返す: 3 → 1 → 3
  g.ctx.tween('hud', { 'Transform.sx': 1 }, { time: 0.05, ease: 'linear', repeat: 1, yoyo: true });
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) { g.step(); seen.push(Number(g.world.get('hud')!.c.Transform.sx.toFixed(2))); }
  assert.deepEqual(seen, [2.33, 1.67, 1, 1.67, 2.33, 3]);
  // 同じ値への新しいトゥイーンは前のを置きかえる
  g.ctx.tween('hud', { 'Transform.sx': 2 }, { time: 1 });
  g.ctx.tween('hud', { 'Transform.sx': 5 }, { time: 1 });
  assert.equal(g.tweens.length, 1);
  g.ctx.stopTween('hud');
  assert.equal(g.tweens.length, 0);
});

test('トゥイーン: 色・遅れ・終わったら消す/出来事。表 $tweens の手触りを使い、間違いはヒント付きで止まる', async () => {
  const p = await Project.load(await fresh());
  const g = p.newGame();
  g.step();
  g.ctx.tween('hud', { 'Text.color': '#000000' }, { time: 0.05, ease: 'linear', delay: 0.05, from: { 'Text.color': '#ffffff' }, emit: 'faded' });
  // 60fps: 遅れ 3フレーム、かける 3フレーム
  for (let i = 0; i < 3; i++) g.step();
  assert.equal(g.world.get('hud')!.c.Text.color, '#e8ecff', '遅れの間は変えない');
  g.step();
  assert.equal(g.world.get('hud')!.c.Text.color, '#aaaaaa');
  g.step();
  g.step();
  assert.equal(g.world.get('hud')!.c.Text.color, '#000000');
  assert.equal(g.counts.get('faded'), 1);
  // 表の手触り（hitFlash: 0.15秒 = 9フレーム）
  g.ctx.tween('hud', { 'Transform.sy': 2 }, 'hitFlash');
  assert.equal(g.tweens[0].frames, 9);
  assert.equal(g.tweens[0].ease, 'outQuad');
  g.ctx.tween('hud', { 'Transform.rot': 90 }, { time: 0.05, destroy: true });
  for (let i = 0; i < 3; i++) g.step();
  assert.equal(g.world.get('hud'), undefined, 'destroy: 終わったら物を消す');
  const g2 = p.newGame();
  g2.step();
  assert.throws(() => g2.ctx.tween('hud', { 'Transform.sx': 2 }, 'hitFlsh'), /\$tweens に hitFlsh はありません.*もしかして: hitFlash/s);
  assert.throws(() => g2.ctx.tween('hud', { 'Transfrom.sx': 2 }), /Transfrom は付いていません.*Transform/s);
  assert.throws(() => g2.ctx.tween('hud', { 'Transform.sz': 2 }), /Transform に sz はありません/);
  assert.throws(() => g2.ctx.tween('hud', { 'Transform.sx': 2 }, { ease: 'outQaud' as never }), /outQaud.*もしかして: outQuad/s);
  assert.throws(() => g2.ctx.tween('hud', { 'Text.color': 'red' }), /色/);
  // 表の ease 列の間違いも、検証で分かる
  await assert.rejects(p.apply([{ op: 'set', path: '$tweens.hitFlash.ease', value: 'outQaud' }], ai), /outQaud.*もしかして: outQuad/s);
});

test('トゥイーン: 進行中のものも結果（hash）と保存（snapshot）に入る。同じ入力なら同じ結果', async () => {
  const p = await Project.load(await fresh());
  const run = (withTween: boolean) => {
    const g = p.newGame();
    g.step();
    if (withTween) g.ctx.tween('hud', { 'Transform.sx': 2 }, { time: 10 });
    for (let i = 0; i < 30; i++) g.step();
    return g;
  };
  const a = run(true), b = run(true), c = run(false);
  assert.equal(a.hash(), b.hash());
  assert.notEqual(a.hash(), c.hash());
  assert.equal((a.snapshot() as { tweens?: unknown[] }).tweens?.length, 1);
});

test('パーティクル: 現れたときに burst の数を出す命令が出て、数えられる。粒そのものはゲームの結果に入らない', async () => {
  const p = await Project.load(await fresh());
  const g = p.newGame();
  const cmds: ParticleCmd[] = [];
  g.particleListeners.push((c) => cmds.push(c));
  const boom = g.world.spawn('explosion', { Transform: { x: 50, y: 60 } });
  g.step();
  assert.deepEqual(cmds.map((c) => [c.id, c.count]), [[boom.id, 14]]);
  assert.equal(g.particleCounts.get('explosion'), 1);
  g.step();
  assert.equal(cmds.length, 1, '一度だけ');
  // 描く側: 粒を動かし、物が消えても残りの粒は消えるまで描く
  const sim = new ParticleSim();
  sim.burst(g.world, boom.id, 14);
  assert.equal(sim.count(), 14);
  sim.update(g.world, 0.1);
  assert.equal(sim.count(), 14);
  assert.equal(collectDrawables(g.world).filter((d) => d.kind === 'particles').length, 1);
  g.world.destroy(boom.id);
  g.world.flush();
  sim.update(g.world, 0.01);
  assert.equal(sim.orphans().length, 1, '物が消えても粒は残る');
  assert.equal(collectDrawables(g.world, sim.orphans()).filter((d) => d.kind === 'particles').length, 1);
  sim.update(g.world, 1);
  assert.equal(sim.count(), 0);
  assert.equal(sim.orphans().length, 0);
  // ない物・Particles のない物へは、警告にして止めない
  g.ctx.particles.burst('hud');
  assert.ok([...g.warnings].some((w) => /burst\("hud"\).*Particles がありません/.test(w)));
});

test('パーティクル: rate で出し続け、autoDestroy なら出し終わって粒が消えたら物を消す。編集中は選んだ物だけ試しに出す', async () => {
  const p = await Project.load(await fresh());
  const g = p.newGame();
  const e = g.world.add({ id: 'fx', name: 'fx', components: { Transform: {}, Particles: { rate: 20, duration: 0.5, lifetime: 0.2, lifetimeJitter: 0, autoDestroy: true } } });
  const sim = new ParticleSim();
  sim.update(g.world, 0.25);
  assert.equal(sim.count(), 5);
  let gone = -1;
  for (let i = 0; i < 120; i++) { g.step(); if (!g.world.get(e.id)) { gone = i; break; } }
  // 0.5秒出して、粒の寿命 0.2秒（ゆらぎ 0）を待つ → 0.7秒 = 42フレームごろ
  assert.ok(gone >= 40 && gone <= 44, `消えたフレーム ${gone}`);
  // 編集中: 選んでいない物は出さない、選んだ物は出す
  const w = p.newGame().world;
  const a = w.add({ id: 'a', name: 'a', components: { Transform: {}, Particles: { rate: 50 } } });
  const b = w.add({ id: 'b', name: 'b', components: { Transform: {}, Particles: { burst: 8 } } });
  const s2 = new ParticleSim();
  s2.update(w, 0.5, []);
  assert.equal(s2.count(), 0);
  s2.update(w, 0.5, [b.id]);
  assert.equal(s2.emitters.get(b.id)?.parts.length, 8);
  assert.equal(s2.emitters.get(a.id), undefined);
});

test('ages run / 地図: 粒を出した回数と、動いているトゥイーンを要約に出す', async () => {
  const dir = await fresh();
  const out = await cmdRun(dir, { frames: '900', keys: '0-900:KeyZ;100-300:ArrowLeft' });
  assert.match(out, /particles: ✦explosion×\d+/);
  const map = await cmdMap(dir);
  assert.match(map, /tweens/);
  assert.match(map, /Particles/);
});
