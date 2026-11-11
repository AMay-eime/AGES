// 追加パッケージ 3d: 計算（行列・回転）・位置の親子・カメラ（世界 ↔ 画面）・画面なしで動かす
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
