// 段階2-10: シェーダー（画像ごとの効果・画面全体の後処理）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { STD_SHADERS, codeHash, parseShader, wrapShader } from '../src/core/shader.ts';
import { writeShaderResult } from '../src/project/shader-status.ts';
import { cmdCheck, cmdMap, cmdRun, cmdSchema } from '../src/cli/ages.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

const WAVE = `// 横に揺らす
// 水の中のように
uniform float amp; // 0..0.1 =0.02 揺れの大きさ
uniform int steps; // 1..16 =4 段数
uniform bool on; // =true 揺らすか
uniform vec2 dir; // =1,0 向き
uniform vec3 tint; // =#FF8000 色
uniform sampler2D noise; // =assets/kenney-pixel-shmup/tiles.png ムラ
vec4 effect(vec4 c, vec2 uv) {
  return pick(uv + dir * sin(uv.y * 40.0 + u_time) * amp) * vec4(tint, 1.0);
}
`;

test('シェーダーのファイル: 先頭のコメントが説明、uniform の行の終わりのコメントが 範囲・既定値・説明', () => {
  const d = parseShader('assets/wave.frag', WAVE);
  assert.deepEqual(d.errors, []);
  assert.equal(d.desc, '横に揺らす 水の中のように');
  assert.deepEqual(d.uniforms.amp, { type: 'number', default: 0.02, min: 0, max: 0.1, step: 0.001, desc: '揺れの大きさ' });
  assert.deepEqual(d.uniforms.steps, { type: 'int', default: 4, min: 1, max: 16, desc: '段数' });
  assert.deepEqual(d.uniforms.on, { type: 'bool', default: true, desc: '揺らすか' });
  assert.deepEqual(d.uniforms.dir, { type: 'vec2', default: [1, 0], desc: '向き' });
  assert.deepEqual(d.uniforms.tint, { type: 'color', default: '#ff8000', desc: '色' });
  assert.deepEqual(d.uniforms.noise, { type: 'asset', kind: 'image', default: 'assets/kenney-pixel-shmup/tiles.png', desc: 'ムラ' });
  assert.deepEqual(Object.keys(d.glsl), ['amp', 'steps', 'on', 'dir', 'tint', 'noise']);
  // エラーの行番号がファイルの行と合うように
  assert.match(wrapShader(d), /#line 1\n\/\/ 横に揺らす/);
  // 標準のシェーダーはどれも読める
  for (const s of STD_SHADERS.values()) assert.deepEqual(s.errors, [], s.path);
});

test('シェーダーのファイル: 書き方の間違いは、行と直し方つきで知らせる', () => {
  const bad = parseShader('a.frag', `uniform float a, b;
uniform mat4 m;
uniform float u_time2;
uniform float x; // 0..1 =5
uniform vec3 col; // =red
void main() {}
`);
  assert.match(bad.errors[0], /a\.frag:1: uniform は1行に1つ/);
  assert.match(bad.errors[1], /a\.frag:2: uniform の型 mat4 は使えません/);
  assert.match(bad.errors[2], /a\.frag:3: u_time2 は AGES が使う名前/);
  assert.match(bad.errors[3], /a\.frag:4: 既定値 5 が範囲 0\.\.1 の外/);
  assert.match(bad.errors[4], /a\.frag:5: vec3 は色として扱います/);
  assert.ok(bad.errors.some((e) => /vec4 effect\(vec4 c, vec2 uv\) がありません/.test(e)));
  assert.ok(bad.errors.some((e) => /main は書きません/.test(e)));
});

test('Effect: 選んだシェーダーの値を params.名前 で指し、範囲・名前を検証する。省いた値は既定値', async () => {
  const p = await Project.load(await fresh());
  const g = p.newGame();
  const e = g.world.spawn('enemy');
  assert.deepEqual(e.c.Effect.params, { amount: 0, color: '#ffffff' }, 'std:flash の既定値で埋まる');
  await p.apply([{ op: 'set', path: '@enemy.Effect.params.amount', value: 0.5 }], ai);
  assert.deepEqual(p.docs.prefabs.get('enemy')!.components.Effect.params, { amount: 0.5 });
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Effect.params.amount', value: 2 }], ai), /最大値 1/);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Effect.params.amout', value: 1 }], ai), /amout という項目はありません.*もしかして: amount/s);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Effect.params', value: { amount: 1, glow: 1 } }], ai), /glow という項目はありません/);
  // シェーダーを選ぶ前は指せない。ないシェーダーは候補つき
  await assert.rejects(p.apply([{ op: 'addComponent', target: '@bullet', component: 'Effect' }, { op: 'set', path: '@bullet.Effect.params.amount', value: 1 }], ai), /先に shader でシェーダーを選んでください/);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Effect.shader', value: 'std:flsh' }], ai), /std:flsh がありません.*もしかして: std:flash/s);
  // シェーダーを変えると、新しいシェーダーにない値は外れる（意味を保つ直し）
  await p.apply([{ op: 'set', path: '@enemy.Effect.shader', value: 'std:dissolve' }], ai);
  assert.deepEqual(p.docs.prefabs.get('enemy')!.components.Effect.params, { amount: 0.5 }, '同じ名前の値は残る');
  const r = await p.apply([{ op: 'set', path: '@enemy.Effect.shader', value: 'std:outline' }], ai);
  assert.deepEqual(p.docs.prefabs.get('enemy')!.components.Effect.params, {});
  assert.deepEqual(r.changes.find((c) => c.path === '@enemy.Effect.params'), { path: '@enemy.Effect.params', from: { amount: 0.5 }, to: {} });
  assert.deepEqual(p.validate(), []);
});

test('プロジェクトのシェーダー: assets の .frag を読み、地図・ages schema に値が1行で出る。間違いは検証で分かる', async () => {
  const dir = await fresh();
  await mkdir(join(dir, 'assets/shaders'), { recursive: true });
  await writeFile(join(dir, 'assets/shaders/wave.frag'), WAVE);
  const p = await Project.load(dir);
  await p.apply([{ op: 'set', path: '@enemy.Effect.shader', value: 'assets/shaders/wave.frag' }, { op: 'set', path: '@enemy.Effect.params.amp', value: 0.05 }], ai);
  assert.equal(p.newGame().world.spawn('enemy').c.Effect.params.steps, 4);
  const map = await cmdMap(dir);
  assert.match(map, /assets\/shaders\/wave\.frag 横に揺らす 水の中のように \| amp:num 0\.\.0\.1=0\.02 steps:int 1\.\.16=4/);
  assert.match(map, /標準: std:flash\(amount,color\)/);
  assert.match(await cmdSchema(dir, ['std:flash']), /--- std:flash の中身/);
  // 画像の値（sampler2D）は、ないファイルを知らせる
  await writeFile(join(dir, 'assets/shaders/wave.frag'), WAVE.replace('=assets/kenney-pixel-shmup/tiles.png', '=assets/none.png'));
  const p2 = await Project.load(dir);
  assert.ok(p2.validate().some((e) => /wave\.frag: noise の既定値のファイル assets\/none\.png がありません/.test(e)), p2.validate().join('\n'));
  await assert.rejects(p2.apply([{ op: 'set', path: '@enemy.Effect.params.noise', value: 'assets/nai.png' }], ai), /params\.noise: ファイル assets\/nai\.png がありません/);
  await writeFile(join(dir, 'assets/shaders/broken.frag'), 'uniform float a;\n');
  assert.ok((await Project.load(dir)).validate().some((e) => /broken\.frag: 関数 vec4 effect/.test(e)));
});

test('トゥイーン: シェーダーの値も "Effect.params.名前" で動かせる', async () => {
  const p = await Project.load(await fresh());
  const g = p.newGame();
  const e = g.world.spawn('enemy');
  g.ctx.tween(e.id, { 'Effect.params.amount': 0, 'Effect.params.color': '#000000' }, { time: 0.05, ease: 'linear', from: { 'Effect.params.amount': 1 } });
  g.step();
  assert.equal(Number(g.world.get(e.id)!.c.Effect.params.amount.toFixed(3)), 0.667);
  for (let i = 0; i < 2; i++) g.step();
  assert.deepEqual(g.world.get(e.id)!.c.Effect.params, { amount: 0, color: '#000000' });
  assert.throws(() => g.ctx.tween(e.id, { 'Effect.params.amout': 1 }), /amout はありません.*もしかして: amount/s);
  assert.throws(() => g.ctx.tween(e.id, { 'Effect.params': 1 }), /'Effect\.params\.名前' で書きます/);
  // サンプル: 弾が当たると白く光る（表 $tweens の hitFlash）
  const out = await cmdRun(p.dir, { frames: '400', keys: '0-400:KeyZ;100-300:ArrowLeft' });
  assert.doesNotMatch(out, /error/);
});

test('ages check: エディタでコンパイルした結果を、今の中身と同じときだけ出す。まだなら確かめていないと書く', async () => {
  const dir = await fresh();
  await mkdir(join(dir, 'assets/shaders'), { recursive: true });
  await writeFile(join(dir, 'assets/shaders/wave.frag'), WAVE);
  assert.match(await cmdCheck(dir), /シェーダー assets\/shaders\/wave\.frag はまだコンパイルを確かめていません/);
  await writeShaderResult(dir, 'assets/shaders/wave.frag', codeHash(WAVE), "assets/shaders/wave.frag:10: 'pick' : no matching overloaded function found");
  const out = await cmdCheck(dir);
  assert.match(out, /error: assets\/shaders\/wave\.frag:10: 'pick'.*（エディタでコンパイルしたときのエラー）/);
  // 中身が変わったら、前の結果は使わない
  await writeFile(join(dir, 'assets/shaders/wave.frag'), WAVE + '\n');
  assert.doesNotMatch(await cmdCheck(dir), /error:/);
  await writeShaderResult(dir, 'assets/shaders/wave.frag', codeHash(WAVE + '\n'), null);
  assert.match(await cmdCheck(dir), /^ok/);
});
