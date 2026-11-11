// 追加パッケージ 3d: 計算（行列・回転）・位置の親子・カメラ（世界 ↔ 画面）・画面なしで動かす
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdInit, cmdPatch, cmdRun, cmdSchema, cmdCheck, cmdMap } = await import('../src/cli/ages.ts');
const m = await import('../src/packages/3d/math.ts');
const { worldMatrix, cameraFrom, defaultCamera3, toScreen, screenRay } = await import('../src/packages/3d/space.ts');

const near = (a: number[], b: number[], eps = 1e-9) => assert.ok(a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

test('回転: ry は上から見て反時計回り（+Z の前が +X へ）・rx が正で前は下へ。順番は ry → rx → rz', () => {
  const fwd = (rx: number, ry: number, rz = 0) => m.transformDirection(m.compose([0, 0, 0], [rx, ry, rz]), [0, 0, 1]);
  near(fwd(0, 0), [0, 0, 1]);
  near(fwd(0, 90), [1, 0, 0]);
  near(fwd(90, 0), [0, -1, 0]);
  near(fwd(30, 90), [Math.cos(Math.PI / 6), -0.5, 0]); // 先に上下、それを左右に回す
  near(m.transformDirection(m.compose([0, 0, 0], [0, 0, 90]), [1, 0, 0]), [0, 1, 0]);
});

test('行列: 作って戻す・逆行列・かけ算', () => {
  const a = m.compose([1, 2, 3], [20, -130, 45], [2, 0.5, 3]);
  const d = m.decompose(a);
  near(d.pos, [1, 2, 3]);
  near(d.rot, [20, -130, 45], 1e-9);
  near(d.scale, [2, 0.5, 3]);
  near(m.multiply(a, m.invert(a)!), m.identity(), 1e-9);
  near(m.transformPoint(m.multiply(m.compose([0, 0, 5], [0, 90, 0]), m.compose([1, 0, 0], [0, 0, 0])), [0, 0, 0]), [0, 0, 4]);
  assert.equal(m.invert(m.compose([0, 0, 0], [0, 0, 0], [0, 1, 1])), null);
  // 真上を向いていても戻せる（rz は 0 に寄せる）
  near(m.decompose(m.compose([0, 0, 0], [90, 40, 0])).rot, [90, 40, 0], 1e-6);
});

test('向ける: 物は +Z、カメラは −Z がその点を向く', () => {
  assert.deepEqual(m.lookRotation([0, 0, 0], [1, 0, 1]), { rx: 0, ry: 45 });
  assert.deepEqual(m.lookRotation([0, 0, 0], [0, 0, -1], true), { rx: 0, ry: 0 });
  const r = m.lookRotation([0, 3, 8], [0, 0, 0], true);
  const cam = cameraFrom('c', m.compose([0, 3, 8], [r.rx, r.ry, 0]), {}, 16 / 9);
  near(cam.dir, m.normalize([0, -3, -8]), 1e-6);
  assert.equal(m.wrapAngle(270), -90);
});

test('位置の親子: 親の位置・回転・倍率が子にかかる（輪になっていても止まる）', () => {
  const all: Record<string, object> = { p: { x: 0, y: 0, z: 5, ry: 90, sx: 2, sy: 2, sz: 2 }, c: { x: 1, parent: 'p' }, a: { parent: 'b' }, b: { parent: 'a', x: 1 } };
  near(m.positionOf(worldMatrix((id) => all[id], all.c)), [0, 0, 3]);
  assert.equal(worldMatrix((id) => all[id], all.a).length, 16);
});

test('カメラ: 世界 → 画面 → 光線で元の点を通る。後ろの点は映らない。遠近なしも', () => {
  for (const c of [defaultCamera3(16 / 9), cameraFrom('o', m.compose([4, 10, 4], [-60, 30, 0]), { projection: 'ortho', size: 6 }, 4 / 3)]) {
    const W = 800, H = c.ortho ? 600 : 450;
    const p: [number, number, number] = [1, 0.5, -2];
    const s = toScreen(c, p, W, H)!;
    assert.ok(s.x > 0 && s.x < W && s.y > 0 && s.y < H && s.depth > 0, JSON.stringify(s));
    const ray = screenRay(c, s.x, s.y, W, H);
    const t = m.dot(m.sub(p, ray.origin), ray.dir);
    assert.ok(m.distance(m.add(ray.origin, m.scale(ray.dir, t)), p) < 1e-6);
    assert.ok(Math.abs(m.distance(m.add(ray.origin, m.scale(ray.dir, t)), c.pos) - 0) >= 0);
  }
  const cam = defaultCamera3(16 / 9);
  const center = toScreen(cam, [0, 0.5, 0], 800, 450)!;
  near([center.x, center.y], [400, 225], 1e-3);
  assert.equal(toScreen(cam, [0, 3, 20], 800, 450), null);
  // 右にある物は画面の右、上にある物は画面の上
  assert.ok(toScreen(cam, [2, 0.5, 0], 800, 450)!.x > 400 && toScreen(cam, [0, 2, 0], 800, 450)!.y < 225);
});

test('画面なしで動かす: Transform3D の物を動かし、カメラが追いかける（ages run）。地図・手順・部品の説明にも出る', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-3d-')), 'g');
  await cmdInit(dir, 'g');
  const cfg = join(dir, 'ages.project.json');
  await writeFile(cfg, JSON.stringify({ ...JSON.parse(await readFile(cfg, 'utf8')), packages: ['3d'] }, null, 2) + '\n');
  await writeFile(join(dir, 'game', 'index.ts'), `import { defineComponent, defineSystem, type GameModule } from 'ages';
import { worldPosition, math3 } from 'ages/3d';
const Walker = defineComponent({ name: 'Walker', desc: '前へ歩く', fields: { speed: { type: 'number', default: 2, min: 0, max: 20, desc: '速さ（m/秒）' }, far: { type: 'number', default: 0, desc: '原点からの距離（自動で変化）' } } });
const walk = defineSystem({ name: 'walk', desc: '前（+Z）へ歩く', reads: ['Walker'], writes: ['Transform3D'], update(ctx) {
  for (const e of ctx.world.entities.values()) { if (!e.c.Walker) continue; e.c.Transform3D.z += e.c.Walker.speed / 60; e.c.Walker.far = math3.length(worldPosition(ctx.world, e)!); }
} });
export const components: GameModule['components'] = [Walker];
export const systems: GameModule['systems'] = [walk];
`);
  await cmdPatch(dir, [
    { op: 'addEntity', scene: 'main', entity: { id: 'player', components: { Transform3D: { x: 1 }, Walker: {} } } },
    { op: 'addEntity', scene: 'main', entity: { id: 'hat', components: { Transform3D: { y: 2, parent: 'player' } } } },
    { op: 'addEntity', scene: 'main', entity: { id: 'cam', components: { Transform3D: {}, Camera3D: { follow: 'player', offset: [0, 3, 6] } } } },
  ], false);
  assert.match(await cmdCheck(dir), /^ok/);
  const out = await cmdRun(dir, { frames: '120', watch: 'player.Transform3D.z,player.Walker.far,cam.Transform3D.z,cam.Transform3D.rx,cam.Transform3D.ry', every: '120' });
  const end = (name: string) => Number(new RegExp(`watch ${name.replaceAll('.', '\\.')}: \\S+ → (\\S+)`).exec(out)?.[1]);
  // 2秒で 4m 進む。カメラは後ろ上 [0, 3, 6] にいて、頭（1m 上）を見下ろす（rx が負）
  near([end('player.Transform3D.z'), end('player.Walker.far'), end('cam.Transform3D.z'), end('cam.Transform3D.rx'), end('cam.Transform3D.ry')], [4, Math.hypot(1, 4), 10, -Math.atan2(2, 6) * 180 / Math.PI, 0], 1e-5);
  assert.match(await cmdMap(dir), /^## package 3d: /m);
  assert.match(await cmdSchema(dir, ['Transform3D']), /^Transform3D: .*（使い方: guide:3d）\n {2}x num=0/m);
  assert.match(await cmdSchema(dir, ['guide']), /^ {2}3d: .*（Transform3D Camera3D）$/m);
});

test('描画: 基本の形・光が画面に出て、2D の UI が上に重なる（ages run --shot）。Transform3D のない部品は ⚠', { skip: (await import('../src/cli/shot.ts')).findChrome() ? false : 'Chrome がない' }, async () => {
  const { decodePng } = await import('../src/project/png.ts');
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-3d-')), 'g');
  await cmdInit(dir, 'g');
  const cfg = join(dir, 'ages.project.json');
  const c = JSON.parse(await readFile(cfg, 'utf8'));
  await writeFile(cfg, JSON.stringify({ ...c, packages: ['3d'], view: { ...c.view, width: 400, height: 300, background: '#9fc4e8' } }, null, 2) + '\n');
  const look = m.lookRotation([0, 3, 8], [0, 1, 0], true);
  const ent = (id: string, components: Record<string, Record<string, unknown>>) => ({ op: 'addEntity' as const, scene: 'main', entity: { id, components } });
  await cmdPatch(dir, [
    ent('ground', { Transform3D: {}, Mesh3D: { shape: 'plane', size: [40, 1, 40], color: '#00ff00', unlit: true } }),
    ent('ball', { Transform3D: { y: 1 }, Mesh3D: { shape: 'sphere', size: [2, 2, 2], color: '#ff0000', unlit: true } }),
    ent('lit', { Transform3D: { x: 3, y: 0.5 }, Mesh3D: { shape: 'box', color: '#ffffff' } }),
    ent('cam', { Transform3D: { y: 3, z: 8, rx: look.rx, ry: look.ry }, Camera3D: {} }),
    ent('hud', { Shape: { kind: 'rect', w: 40, h: 20, color: '#0000ff' }, UI: { anchor: 'topLeft', x: 0, y: 0 } }),
    ent('ghost', { Mesh3D: {} }),
  ], false);
  assert.match(await cmdCheck(dir), /⚠ 3d-transform: main#ghost: Mesh3D があるのに Transform3D がありません/);
  const out = await cmdRun(dir, { frames: '1', shot: '1', 'shot-dir': join(dir, 'shots') });
  assert.match(out, /shot f1: \S+main-f1\.png 400x300/);
  const png = decodePng(await readFile(join(dir, 'shots', 'main-f1.png')));
  const at = (x: number, y: number) => [...png.data.subarray((y * png.w + x) * 4, (y * png.w + x) * 4 + 3)];
  assert.deepEqual([png.w, png.h], [400, 300]);
  assert.deepEqual(at(200, 150), [255, 0, 0], '真ん中は球（光を受けない赤）');
  assert.deepEqual(at(200, 280), [0, 255, 0], '下は床');
  assert.deepEqual(at(380, 10), [0x9f, 0xc4, 0xe8], '上は背景の色（空）');
  assert.deepEqual(at(10, 5), [0, 0, 255], '2D の UI は 3D の上');
  // 光を受ける箱: 上の面は明るく、白より暗い（既定の太陽と全体の明るさ）
  const { toScreen, cameraFrom } = await import('../src/packages/3d/space.ts');
  const cam = cameraFrom('cam', m.compose([0, 3, 8], [look.rx, look.ry, 0]), {}, 400 / 300);
  const top = toScreen(cam, [3, 1, 0], 400, 300)!;
  const px = at(Math.round(top.x), Math.round(top.y));
  assert.ok(px[0] > 120 && px[1] > 120 && px[0] !== 0x9f, `箱の上の面 ${px}`);
});

test('モデル（.glb）: 読む（頂点・ノードの位置・材質・囲む箱・動きの名前）。ages assets に大きさと動きが出る', async () => {
  const { makeGlb } = await import('./util-glb.ts');
  const { parseGlb, summarizeGlb } = await import('../src/packages/3d/gltf.ts');
  const { cmdAssets } = await import('../src/cli/ages.ts');
  const glb = makeGlb({ color: [0.2, 0.4, 0.6, 1], translation: [0, 1, 0], scale: [2, 1, 1], clips: ['idle', 'walk'] });
  const g = parseGlb(glb);
  assert.deepEqual([g.meshes[0][0].vertices.length / 8, g.meshes[0][0].indices.length, g.tris], [24, 36, 12]);
  near(g.materials[0].color, [0.2, 0.4, 0.6, 1], 1e-6);
  near([...g.min, ...g.max], [-1, 0.5, -0.5, 1, 1.5, 0.5]);
  assert.deepEqual(summarizeGlb(glb), { size: [2, 1, 1], center: [0, 1, 0], tris: 12, clips: ['idle', 'walk'], clipSec: [0, 0] });
  assert.throws(() => parseGlb(new Uint8Array(40)), /\.glb ではありません/);

  const dir = join(await mkdtemp(join(tmpdir(), 'ages-3d-')), 'g');
  await cmdInit(dir, 'g');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'crate.glb'), glb);
  assert.match(await cmdAssets(dir, undefined, {}), /crate\.glb.* 2x1x1m 中心\[0,1,0\] 三角形12 動き: idle\(0s\) walk\(0s\)/);
});

test('モデルの描画: 材質の色と中の画像で描かれる（ages run --shot）', { skip: (await import('../src/cli/shot.ts')).findChrome() ? false : 'Chrome がない' }, async () => {
  const { makeGlb, png1x1 } = await import('./util-glb.ts');
  const { decodePng } = await import('../src/project/png.ts');
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-3d-')), 'g');
  await cmdInit(dir, 'g');
  const cfg = join(dir, 'ages.project.json');
  const c = JSON.parse(await readFile(cfg, 'utf8'));
  await writeFile(cfg, JSON.stringify({ ...c, packages: ['3d'], view: { ...c.view, width: 400, height: 300, background: '#000000' } }, null, 2) + '\n');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'red.glb'), makeGlb({ color: [1, 0, 0, 1], unlit: true }));
  await writeFile(join(dir, 'assets', 'tex.glb'), makeGlb({ color: [1, 1, 1, 1], unlit: true, image: png1x1([0, 0, 255, 255]) }));
  const ent = (id: string, components: Record<string, Record<string, unknown>>) => ({ op: 'addEntity' as const, scene: 'main', entity: { id, components } });
  await cmdPatch(dir, [
    ent('a', { Transform3D: { x: -1.5 }, Model3D: { model: 'assets/red.glb' } }),
    ent('b', { Transform3D: { x: 1.5 }, Model3D: { model: 'assets/tex.glb', color: '#80ffff' } }),
    ent('cam', { Transform3D: { z: 6 }, Camera3D: {} }),
  ], false);
  assert.match(await cmdCheck(dir), /^ok/);
  await cmdRun(dir, { frames: '1', shot: '1', 'shot-dir': join(dir, 'shots') });
  const png = decodePng(await readFile(join(dir, 'shots', 'main-f1.png')));
  const at = (x: number, y: number) => [...png.data.subarray((y * png.w + x) * 4, (y * png.w + x) * 4 + 3)];
  const { toScreen, cameraFrom } = await import('../src/packages/3d/space.ts');
  const cam = cameraFrom('cam', m.compose([0, 0, 6], [0, 0, 0]), {}, 400 / 300);
  const pa = toScreen(cam, [-1.5, 0, 0.5], 400, 300)!, pb = toScreen(cam, [1.5, 0, 0.5], 400, 300)!;
  assert.deepEqual(at(Math.round(pa.x), Math.round(pa.y)), [255, 0, 0], '材質の色');
  assert.deepEqual(at(Math.round(pb.x), Math.round(pb.y)), [0, 0, 255], '中の画像（青）に、掛け合わせる色 #80ffff（青はそのまま）');
  assert.deepEqual(at(200, 150), [0, 0, 0], '間は背景');
});

test('モデルの動き: 骨と動きを読む・時刻の姿勢・骨の行列・切り替えの混ぜ方', async () => {
  const { makeGlb } = await import('./util-glb.ts');
  const { parseGlb, summarizeGlb } = await import('../src/packages/3d/gltf.ts');
  const { clipTime, samplePose, poseMatrices, jointMatrices, modelPose } = await import('../src/packages/3d/animation.ts');
  const glb = makeGlb({ skinned: true });
  const g = parseGlb(glb);
  assert.deepEqual(g.skins[0].joints, [1, 2]);
  assert.deepEqual(g.animations.map((a) => [a.name, a.duration, a.channels.length]), [['bend', 1, 1], ['slide', 1, 1]]);
  assert.equal(g.meshes[0][0].skin!.length, 24 * 8);
  assert.deepEqual(summarizeGlb(glb).clipSec, [1, 1]);
  const [bend, slide] = g.animations;
  near([clipTime(bend, 2.25, true), clipTime(bend, 2.25, false), clipTime(bend, -0.25, true), clipTime(bend, -1, false)], [0.25, 1, 0.75, 0]);
  // 骨 k の行列で、点がどこへ動くか
  const moved = (worlds: number[][], k: number, pt: [number, number, number]) => m.transformPoint([...jointMatrices(g, 0, worlds).subarray(k * 16, k * 16 + 16)], pt);
  // 元の姿勢: 動かない
  const rest = poseMatrices(g, samplePose(g, null, 0));
  near(moved(rest, 0, [0.5, -0.5, 0.5]), [0.5, -0.5, 0.5], 1e-6);
  near(moved(rest, 1, [0.5, 0.5, 0.5]), [0.5, 0.5, 0.5], 1e-6);
  // bend の半分: 上の骨が z 軸まわりに 45度
  near(samplePose(g, bend, 0.5)[2]!.r, [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)], 1e-6);
  // bend の終わり: 上の骨の頂点が 90度回る。下の骨はそのまま
  const bent = poseMatrices(g, samplePose(g, bend, 1));
  near(moved(bent, 1, [0.5, 0.5, 0]), [-0.5, 0.5, 0], 1e-6);
  near(moved(bent, 0, [0.5, -0.5, 0]), [0.5, -0.5, 0], 1e-6);
  // slide の半分: 下の骨が x へ 1m。子の上の骨もついていく
  const slid = poseMatrices(g, samplePose(g, slide, 0.5));
  near(moved(slid, 0, [0, -0.5, 0]), [1, -0.5, 0], 1e-6);
  near(moved(slid, 1, [0.5, 0.5, 0]), [1.5, 0.5, 0], 1e-6);
  // 切り替えの途中（bend の終わり → slide の終わり、半分まで混ざった所）: x へ 1m、上は 45度
  const mid = modelPose(g, { clip: 'slide', time: 1, loop: false, prevClip: 'bend', prevTime: 1, fade: 0.2, fadeLeft: 0.1 })!;
  near(moved(mid, 1, [0.5, 0.5, 0]), [1, Math.SQRT1_2, 0], 1e-6);
  // 名前のない動きは元の姿勢。骨のないモデルは null（動かさずに描く）
  near(moved(modelPose(g, { clip: 'nope' })!, 1, [0.5, 0.5, 0]), [0.5, 0.5, 0], 1e-6);
  assert.equal(modelPose(parseGlb(makeGlb()), {}), null);
});

test('モデルの動き: Model3D.clip で時刻が進み、書き換えると前の動きから混ざる（ages run）。ない名前は ⚠', async () => {
  const { makeGlb } = await import('./util-glb.ts');
  const { cmdAssets } = await import('../src/cli/ages.ts');
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-3d-')), 'g');
  await cmdInit(dir, 'g');
  const cfg = join(dir, 'ages.project.json');
  await writeFile(cfg, JSON.stringify({ ...JSON.parse(await readFile(cfg, 'utf8')), packages: ['3d'] }, null, 2) + '\n');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'arm.glb'), makeGlb({ skinned: true }));
  await writeFile(join(dir, 'game', 'index.ts'), `import { defineComponent, defineSystem, type GameModule } from 'ages';
const Switch = defineComponent({ name: 'Switch', desc: '30フレーム目に動きを変える', fields: { n: { type: 'int', default: 0 } } });
const change = defineSystem({ name: 'change', desc: '動きを変える', reads: ['Switch'], writes: ['Model3D'], update(ctx) {
  for (const e of ctx.world.entities.values()) { if (!e.c.Switch) continue; if (++e.c.Switch.n === 30) e.c.Model3D.clip = 'slide'; }
} });
export const components: GameModule['components'] = [Switch];
export const systems: GameModule['systems'] = [change];
`);
  await cmdPatch(dir, [
    { op: 'addEntity', scene: 'main', entity: { id: 'hero', components: { Transform3D: {}, Model3D: { model: 'assets/arm.glb', clip: 'bend', time: 0.25 }, Switch: {} } } },
    { op: 'addEntity', scene: 'main', entity: { id: 'still', components: { Transform3D: { x: 3 }, Model3D: { model: 'assets/arm.glb' } } } },
  ], false);
  assert.match(await cmdCheck(dir), /^ok/);
  assert.match(await cmdAssets(dir, undefined, {}), /arm\.glb.* 動き: bend\(1s\) slide\(1s\)/);
  const run = async (frames: number) => {
    const out = await cmdRun(dir, { frames: String(frames), watch: 'hero.Model3D.time,hero.Model3D.prevTime,hero.Model3D.fadeLeft,still.Model3D.time', every: String(frames) });
    return (name: string) => Number(new RegExp(`watch ${name.replaceAll('.', '\\.')}: \\S+ → (\\S+)`).exec(out)?.[1]);
  };
  // 1フレーム目に始まり（書いてある 0.25 秒から）、2フレーム目から進む
  let end = await run(29);
  near([end('hero.Model3D.time'), end('hero.Model3D.fadeLeft'), end('still.Model3D.time')], [0.25 + 28 / 60, 0, 0], 1e-6);
  // 30フレーム目に切り替え: 新しい動きは 0 秒から。前の動きは切り替えた時の姿勢で止まり、fade（0.15秒）の残りが減る
  end = await run(35);
  near([end('hero.Model3D.time'), end('hero.Model3D.prevTime'), end('hero.Model3D.fadeLeft')], [5 / 60, 0.25 + 28 / 60, 0.15 - 5 / 60], 1e-6);
  // くり返しは長さ（1秒）で折り返す: 切り替えから 75フレーム（1.25秒）で 0.25
  end = await run(105);
  near([end('hero.Model3D.time'), end('hero.Model3D.fadeLeft')], [0.25, 0], 1e-6);
  // くり返さない動きは最後で止まり、done になる（次の動きへ移る合図）
  await cmdPatch(dir, [{ op: 'set', path: 'main#still.Model3D.clip', value: 'bend' }, { op: 'set', path: 'main#still.Model3D.loop', value: false }], false);
  const once = await cmdRun(dir, { frames: '90', watch: 'still.Model3D.time,still.Model3D.done', every: '90' });
  assert.match(once, /watch still\.Model3D\.time: \S+ → 1\b/);
  assert.match(once, /watch still\.Model3D\.done: false → true/);

  await cmdPatch(dir, [{ op: 'set', path: 'main#still.Model3D.clip', value: 'walk' }], false);
  assert.match(await cmdCheck(dir), /⚠ 3d-clip: main#still\.Model3D\.clip: assets\/arm\.glb に動き walk がありません（あるのは bend slide）/);
});

test('モデルの動きの描画: 骨で形が変わる・動かないものは元の形（ages run --shot）', { skip: (await import('../src/cli/shot.ts')).findChrome() ? false : 'Chrome がない' }, async () => {
  const { makeGlb } = await import('./util-glb.ts');
  const { decodePng } = await import('../src/project/png.ts');
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-3d-')), 'g');
  await cmdInit(dir, 'g');
  const cfg = join(dir, 'ages.project.json');
  const c = JSON.parse(await readFile(cfg, 'utf8'));
  await writeFile(cfg, JSON.stringify({ ...c, packages: ['3d'], view: { ...c.view, width: 400, height: 300, background: '#000000' } }, null, 2) + '\n');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'arm.glb'), makeGlb({ color: [1, 0, 0, 1], unlit: true, skinned: true }));
  const ent = (id: string, components: Record<string, Record<string, unknown>>) => ({ op: 'addEntity' as const, scene: 'main', entity: { id, components } });
  await cmdPatch(dir, [
    // 終わりの姿勢で止める（loop なし・time を終わりに）
    ent('bend', { Transform3D: {}, Model3D: { model: 'assets/arm.glb', clip: 'bend', loop: false, time: 1 } }),
    ent('slide', { Transform3D: { x: -1, y: 1.5 }, Model3D: { model: 'assets/arm.glb', clip: 'slide', loop: false, time: 1 } }),
    ent('still', { Transform3D: { y: -1.5 }, Model3D: { model: 'assets/arm.glb' } }),
    ent('cam', { Transform3D: { z: 6 }, Camera3D: {} }),
  ], false);
  assert.match(await cmdCheck(dir), /^ok/);
  await cmdRun(dir, { frames: '2', shot: '2', 'shot-dir': join(dir, 'shots') });
  const png = decodePng(await readFile(join(dir, 'shots', 'main-f2.png')));
  const { toScreen, cameraFrom } = await import('../src/packages/3d/space.ts');
  const cam = cameraFrom('cam', m.compose([0, 0, 6], [0, 0, 0]), {}, 400 / 300);
  const at = (x: number, y: number) => { const s = toScreen(cam, [x, y, 0.5], 400, 300)!; const o = (Math.round(s.y) * png.w + Math.round(s.x)) * 4; return [...png.data.subarray(o, o + 3)]; };
  // bend: 上の辺が左へ倒れ、手前の面は左下の三角になる
  assert.deepEqual(at(-0.3, -0.3), [255, 0, 0], '曲がった後も左下は面の中');
  assert.deepEqual(at(0.3, 0.3), [0, 0, 0], '右上は面の外になる');
  // slide: 箱ごと x へ 2m（-1 → 1）
  assert.deepEqual(at(1, 1.5), [255, 0, 0], '動いた先');
  assert.deepEqual(at(-1, 1.5), [0, 0, 0], '元の場所にはいない');
  // 動きを書いていないモデルは元の形（右上も面の中）
  assert.deepEqual(at(0.3, -1.2), [255, 0, 0], '元の姿勢');
});

test('影: 太陽の影が床に落ちる。日なたの明るさは影なしと同じ（縞が出ない）。物・光ごとに切れる（ages run --shot）', { skip: (await import('../src/cli/shot.ts')).findChrome() ? false : 'Chrome がない' }, async () => {
  const { decodePng } = await import('../src/project/png.ts');
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-3d-')), 'g');
  await cmdInit(dir, 'g');
  const cfg = join(dir, 'ages.project.json');
  const c = JSON.parse(await readFile(cfg, 'utf8'));
  await writeFile(cfg, JSON.stringify({ ...c, packages: ['3d'], view: { ...c.view, width: 400, height: 300, background: '#000000' } }, null, 2) + '\n');
  const ent = (id: string, components: Record<string, Record<string, unknown>>) => ({ op: 'addEntity' as const, scene: 'main', entity: { id, components } });
  await cmdPatch(dir, [
    ent('floor', { Transform3D: {}, Mesh3D: { shape: 'plane', size: [20, 1, 20], roughness: 1 } }),
    ent('box', { Transform3D: { y: 2 }, Mesh3D: { roughness: 1 } }),
    // 真上からの太陽（前 +Z を rx 90 で下へ）
    ent('sun', { Transform3D: { rx: 90 }, Light3D: { intensity: 0.5 } }),
    ent('cam', { Transform3D: { y: 1, z: 6 }, Camera3D: {} }),
  ], false);
  const { toScreen, cameraFrom } = await import('../src/packages/3d/space.ts');
  const cam = cameraFrom('cam', m.compose([0, 1, 6], [0, 0, 0]), {}, 400 / 300);
  const shot = async () => {
    await cmdRun(dir, { frames: '1', shot: '1', 'shot-dir': join(dir, 'shots') });
    const png = decodePng(await readFile(join(dir, 'shots', 'main-f1.png')));
    return (x: number, z: number) => { const s = toScreen(cam, [x, 0, z], 400, 300)!; return png.data[(Math.round(s.y) * png.w + Math.round(s.x)) * 4]; };
  };
  // 箱の真下は影（太陽のぶん暗い）、離れた所は日なた。箱の影のふち（x = 0.5）の外はもう日なた
  const on = await shot();
  assert.ok(on(2, 0) - on(0, 0) > 60, `影 ${on(0, 0)} 日なた ${on(2, 0)}`);
  assert.ok(Math.abs(on(2, 0) - on(0.8, 0)) <= 2, `ふちの外 ${on(0.8, 0)}`);
  assert.ok(on(0.3, 0.3) < on(2, 0) - 60, '箱の下の隅も影');
  // 物の shadow を切ると落ちない
  await cmdPatch(dir, [{ op: 'set', path: 'main#box.Mesh3D.shadow', value: false }], false);
  const noCast = await shot();
  assert.ok(Math.abs(noCast(0, 0) - noCast(2, 0)) <= 2, `落とさない ${noCast(0, 0)} ${noCast(2, 0)}`);
  // 光の shadow を切ると、どこも日なた。日なたの明るさは影ありのときと同じ（床が自分の影で暗くならない）
  await cmdPatch(dir, [{ op: 'set', path: 'main#box.Mesh3D.shadow', value: true }, { op: 'set', path: 'main#sun.Light3D.shadow', value: false }], false);
  const off = await shot();
  assert.ok(Math.abs(off(0, 0) - off(2, 0)) <= 2, `影なし ${off(0, 0)} ${off(2, 0)}`);
  for (const [x, z] of [[2, 0], [-3, 1], [1.5, 2.5], [4, -4]]) assert.ok(Math.abs(off(x, z) - on(x, z)) <= 2, `日なた (${x}, ${z}): 影あり ${on(x, z)} 影なし ${off(x, z)}`);
});

test('当たり判定の形: 箱・球・カプセルの重なり、点、線（当たった所と面の向き）', async () => {
  const { shapeFrom, overlap3, contains3, rayHit3, sphereShape, boxShapeAt } = await import('../src/packages/3d/collide.ts');
  const at = (shape: string, pos: [number, number, number], size: [number, number, number] = [1, 1, 1], rot: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]) => shapeFrom({ shape, size }, m.compose(pos, rot, scale));
  // 球どうし: 太さ 1（半径 0.5）。中心が 1 より近ければ重なる（ちょうど触れているだけは重ならない）
  assert.equal(overlap3(at('sphere', [0, 0, 0]), at('sphere', [0.99, 0, 0])), true);
  assert.equal(overlap3(at('sphere', [0, 0, 0]), at('sphere', [1, 0, 0])), false);
  // 倍率がかかる（2倍の球は半径 1）
  assert.equal(overlap3(at('sphere', [0, 0, 0], [1, 1, 1], [0, 0, 0], [2, 2, 2]), at('sphere', [1.4, 0, 0])), true);
  // カプセル（太さ 1・高さ 3）: 芯は y = -1〜1。横に寝かせると x に伸びる
  const cap = at('capsule', [0, 0, 0], [1, 3, 1]);
  assert.equal(overlap3(cap, at('sphere', [0, 1.9, 0])), true, '上の丸み');
  assert.equal(overlap3(cap, at('sphere', [0, 2.1, 0])), false);
  assert.equal(overlap3(cap, at('sphere', [0.9, 0.5, 0])), true, '胴');
  assert.equal(overlap3(at('capsule', [0, 0, 0], [1, 3, 1], [0, 0, 90]), at('sphere', [1.9, 0, 0])), true, '寝かせたカプセル');
  assert.equal(overlap3(cap, at('capsule', [0.95, 2, 0], [1, 3, 1])), true, 'カプセルどうし');
  assert.equal(overlap3(cap, at('capsule', [1.05, 2, 0], [1, 3, 1])), false);
  // 箱と球: 角の近く（箱の角 [0.5,0.5,0.5] から球の中心まで 0.49 / 0.52）
  const box = at('box', [0, 0, 0]);
  const k = 1 / Math.sqrt(3);
  assert.equal(overlap3(box, at('sphere', [0.5 + 0.49 * k, 0.5 + 0.49 * k, 0.5 + 0.49 * k])), true);
  assert.equal(overlap3(box, at('sphere', [0.5 + 0.52 * k, 0.5 + 0.52 * k, 0.5 + 0.52 * k])), false);
  assert.equal(overlap3(at('box', [0, 0, 0], [4, 4, 4]), at('sphere', [0, 0, 0], [0.2, 0.2, 0.2])), true, '中にすっぽり入っている');
  // 箱とカプセル: 箱の上をまたぐ、寝かせたカプセル
  assert.equal(overlap3(box, at('capsule', [0, 0.95, 0], [1, 4, 1], [0, 0, 90])), true);
  assert.equal(overlap3(box, at('capsule', [0, 1.05, 0], [1, 4, 1], [0, 0, 90])), false);
  // 箱どうし: 45度回した箱は、角が x へ 0.707 まで出る。外枠は重なっても、形は離れていることがある
  const turned = (x: number, z = 0) => at('box', [x, 0, z], [1, 1, 1], [0, 45, 0]);
  assert.equal(overlap3(box, turned(1.2)), true);
  assert.equal(overlap3(box, turned(1.21)), false);
  assert.equal(overlap3(box, turned(1.1, 1.1)), false, '外枠は重なるが、角どうしは離れている');
  assert.equal(overlap3(box, turned(0.8, 0.8)), true);
  // 点
  assert.equal(contains3(turned(0), [0.69, 0, 0]), true);
  assert.equal(contains3(turned(0), [0.49, 0, 0.49]), false);
  assert.equal(contains3(cap, [0, 1.4, 0]), true);
  // 検索用の形
  assert.equal(overlap3(sphereShape([0, 0, 0], 0.5), boxShapeAt([0.9, 0, 0], [1, 1, 1])), true);
  // 線: 箱の手前の面に当たる（t は 0〜1、面の向きは線が来た側）
  const hb = rayHit3(box, [0, 0, 5], [0, 0, -5])!;
  near([hb.t, ...hb.normal], [0.45, 0, 0, 1]);
  near(rayHit3(turned(0), [5, 0, 0], [-5, 0, 0])!.normal.map(Math.abs), [Math.SQRT1_2, 0, Math.SQRT1_2], 1e-9);
  assert.equal(rayHit3(box, [0, 2, 5], [0, 2, -5]), null);
  assert.equal(rayHit3(box, [0, 0, 5], [0, 0, 1]), null, '届かない');
  // 球: 上から落とすと、てっぺんに当たり、面は上を向く
  const hs = rayHit3(at('sphere', [0, 0, 0], [2, 2, 2]), [0, 5, 0], [0, -5, 0])!;
  near([hs.t, ...hs.normal], [0.4, 0, 1, 0]);
  // カプセル: 胴（横から）と丸み（上から）
  const hc = rayHit3(cap, [5, 0.5, 0], [-5, 0.5, 0])!;
  near([hc.t, ...hc.normal], [0.45, 1, 0, 0]);
  near([rayHit3(cap, [0, 5, 0], [0, -5, 0])!.t], [0.35]);
  // 始まりが中なら 0
  assert.equal(rayHit3(box, [0, 0, 0], [0, 0, 5])!.t, 0);
});

test('当たり判定: hit3 の検索と、with の記録（touching・entered）。グループの間違いは ⚠（ages run）', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-3d-')), 'g');
  await cmdInit(dir, 'g');
  const cfg = join(dir, 'ages.project.json');
  await writeFile(cfg, JSON.stringify({ ...JSON.parse(await readFile(cfg, 'utf8')), packages: ['3d'] }, null, 2) + '\n');
  await writeFile(join(dir, 'game', 'index.ts'), `import { defineComponent, defineSystem, type GameModule } from 'ages';
import { hit3 } from 'ages/3d';
const Probe = defineComponent({ name: 'Probe', desc: '検索の結果を書く', fields: {
  speed: { type: 'number', default: 2 }, got: { type: 'int', default: 0 }, seen: { type: 'string', default: '' }, ground: { type: 'number', default: -1 }, near: { type: 'string', default: '' }, wall: { type: 'string', default: '' },
} });
const walk = defineSystem({ name: 'walk', desc: '+X へ歩き、コインを拾う', reads: ['Probe'], writes: ['Transform3D'], update(ctx) {
  const e = ctx.world.entities.get('player')!, p = e.c.Probe, t = e.c.Transform3D;
  // 先に、前のフレームの終わりに重なり始めたコインを拾う
  for (const id of hit3.entered(ctx.world, 'player', 'coin')) { p.got++; ctx.destroy(id); }
  t.x += p.speed * ctx.dt;
  p.seen = hit3.overlaps(ctx.world, 'player').join(',');
  p.ground = hit3.ray(ctx.world, [t.x, t.y, t.z], [t.x, t.y - 10, t.z], 'ground')?.dist ?? -1;
  p.near = hit3.sphere(ctx.world, [t.x, t.y, t.z], 3, 'coin').join(',');
  p.wall = hit3.ray(ctx.world, [t.x, t.y + 1, t.z], [t.x + 20, t.y + 1, t.z], 'wall')?.id ?? '';
} });
export const components: GameModule['components'] = [Probe];
export const systems: GameModule['systems'] = [walk];
`);
  const ent = (id: string, components: Record<string, Record<string, unknown>>) => ({ op: 'addEntity' as const, scene: 'main', entity: { id, components } });
  await cmdPatch(dir, [
    // 足元が原点のキャラクター（高さ 1.8 のカプセルを 0.9 上へ）
    ent('player', { Transform3D: {}, Collider3D: { shape: 'capsule', size: [0.8, 1.8, 0.8], offset: [0, 0.9, 0], group: 'player', with: ['coin'] }, Probe: {} }),
    ent('floor', { Transform3D: { y: -0.5 }, Collider3D: { size: [40, 1, 40], group: 'ground' } }),
    ent('coin1', { Transform3D: { x: 2, y: 1 }, Collider3D: { shape: 'sphere', size: [0.6, 0.6, 0.6], group: 'coin' } }),
    ent('coin2', { Transform3D: { x: 4, y: 1 }, Collider3D: { shape: 'sphere', size: [0.6, 0.6, 0.6], group: 'coin' } }),
    ent('far', { Transform3D: { x: 4, y: 1, z: 5 }, Collider3D: { shape: 'sphere', size: [0.6, 0.6, 0.6], group: 'coin' } }),
    ent('wall', { Transform3D: { x: 8, y: 1 }, Collider3D: { size: [1, 2, 6], group: 'wall' } }),
  ], false);
  assert.match(await cmdCheck(dir), /^ok/);
  const run = async (frames: number) => {
    const out = await cmdRun(dir, { frames: String(frames), watch: 'player.Probe.got,player.Probe.seen,player.Probe.ground,player.Probe.near,player.Probe.wall,player.Transform3D.x,player.Collider3D.touching', every: String(frames) });
    return (name: string) => new RegExp(`watch player\\.${name.replaceAll('.', '\\.')}: .* → (.*)$`, 'm').exec(out)?.[1];
  };
  // 0.5秒（x = 1）: まだ届かない（コインの左はし 1.7、カプセルの右はし 1.4）。足元の地面まで 0（原点が床の上）
  let end = await run(30);
  assert.deepEqual([end('Probe.got'), end('Probe.seen'), end('Probe.near'), end('Probe.wall')], ['0', '', 'coin1,coin2', 'wall']);
  near([Number(end('Probe.ground'))], [0], 1e-9);
  // 2秒（x = 4）: 2つ拾った。遠くのコイン（z = 5）は拾っていない
  end = await run(120);
  assert.deepEqual([end('Probe.got'), end('Probe.near')], ['2', '']);
  // 4秒（x = 8）: 壁の中（押し返しはない）。重なっているのは壁
  end = await run(240);
  assert.equal(end('Probe.seen'), 'wall');

  await cmdPatch(dir, [{ op: 'set', path: 'main#player.Collider3D.with', value: ['coin', 'enemy'] }], false);
  assert.match(await cmdCheck(dir), /⚠ 3d-group: main#player\.Collider3D\.with: グループ enemy の Collider3D がどこにもありません（あるのは player ground coin wall）/);
});
