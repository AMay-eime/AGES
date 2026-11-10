// エディタのゲームの画面の取っ手（移動・回転・拡大縮小）の形と、ドラッグの量
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIZMO, gizmoFrame, hitGizmo, moveDelta, rotateDelta, scaleFactor, tidyRot, tidyScale } from '../src/editor/gizmo.ts';
import { worldToScreen, type CameraView } from '../src/core/camera.ts';

const cam = (over: Partial<CameraView> = {}): CameraView => ({ id: null, x: 0, y: 0, rot: 0, zoom: 2, vx: 0, vy: 0, vw: 400, vh: 400, layerMin: -Infinity, layerMax: Infinity, depth: 0, clear: null, ...over });
const close = (a: number[], b: number[], eps = 1e-6) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${a} ≒ ${b}`));

test('取っ手の枠組み: 移動はワールドの軸、拡大縮小・回転は物の向き（カメラが回れば一緒に）', () => {
  const c = cam();
  const f = gizmoFrame((x, y) => worldToScreen(c, x, y), { x: 10, y: 20, rot: 90 });
  close(f.c, [220, 240]);
  close(f.wx, [1, 0]);
  close(f.wy, [0, 1]);
  close(f.ox, [0, 1], 1e-9); // 90度（時計回り）で物の x 軸は下向き
  close(f.oy, [-1, 0], 1e-9);
  const r = cam({ rot: 90 });
  const g = gizmoFrame((x, y) => worldToScreen(r, x, y), { x: 0, y: 0, rot: 0 });
  close(g.wx, [0, -1], 1e-9); // カメラが90度回ると、ワールドの x 軸は画面の上向き
});

test('取っ手の当たり: 真ん中・軸・輪。外れは null', () => {
  const c = cam();
  const f = gizmoFrame((x, y) => worldToScreen(c, x, y), { x: 0, y: 0, rot: 0 });
  const [cx, cy] = f.c;
  assert.equal(hitGizmo('move', f, [cx + 1, cy - 1]), 'xy');
  assert.equal(hitGizmo('move', f, [cx + GIZMO.len, cy + 2]), 'x');
  assert.equal(hitGizmo('move', f, [cx - 2, cy + GIZMO.len * 0.6]), 'y');
  assert.equal(hitGizmo('move', f, [cx + 40, cy + 40]), null);
  assert.equal(hitGizmo('move', f, [cx - GIZMO.len, cy]), null, '軸の逆向きには取っ手がない');
  assert.equal(hitGizmo('rotate', f, [cx + GIZMO.ring + 3, cy]), 'ring');
  assert.equal(hitGizmo('rotate', f, [cx + 5, cy]), null, '回転は輪だけ');
  // 拡大縮小は物の向きの軸
  const g = gizmoFrame((x, y) => worldToScreen(c, x, y), { x: 0, y: 0, rot: 90 });
  assert.equal(hitGizmo('scale', g, [cx, cy + GIZMO.len]), 'x');
  assert.equal(hitGizmo('scale', g, [cx - GIZMO.len, cy]), 'y');
});

test('ドラッグの量: 移動は軸だけ・回転は時計回りが正・拡大縮小は真ん中からの割合', () => {
  assert.deepEqual(moveDelta('x', 5, 7), [5, 0]);
  assert.deepEqual(moveDelta('y', 5, 7), [0, 7]);
  assert.deepEqual(moveDelta('xy', 5, 7), [5, 7]);
  const c = cam();
  const f = gizmoFrame((x, y) => worldToScreen(c, x, y), { x: 0, y: 0, rot: 0 });
  const [cx, cy] = f.c;
  assert.ok(Math.abs(rotateDelta(f, [cx + 50, cy], [cx, cy + 50]) - 90) < 1e-9, '右 → 下 は +90度（時計回り）');
  assert.ok(Math.abs(rotateDelta(f, [cx + 50, cy], [cx, cy - 50]) + 90) < 1e-9);
  assert.ok(Math.abs(rotateDelta(f, [cx - 50, cy + 1], [cx - 50, cy - 1])) < 5, '真後ろを越えても小さな動きは小さいまま');
  close(scaleFactor('x', f, [cx + 64, cy], [cx + 128, cy]), [2, 1]);
  close(scaleFactor('y', f, [cx, cy + 64], [cx, cy + 32]), [1, 0.5]);
  close(scaleFactor('x', f, [cx + 64, cy], [cx - 64, cy]), [-1, 1], 1e-9); // 真ん中を越えると裏返る
  close(scaleFactor('xy', f, [cx, cy], [cx + 50, cy - 50]), [2, 2]);
  assert.equal(scaleFactor('xy', f, [cx, cy], [cx - 500, cy])[0], 0.01, '縦横そろえるときは裏返さない');
});

test('値のそろえ方: 角度は ±360 の中・倍率は ±20 の中で 0 にしない', () => {
  assert.equal(tidyRot(372.34), 12.3);
  assert.equal(tidyRot(-371), -11);
  assert.equal(tidyRot(44, 15), 45);
  assert.equal(tidyRot(-0.01), 0);
  assert.equal(tidyScale(1.234), 1.23);
  assert.equal(tidyScale(1.27, 0.1), 1.3);
  assert.equal(tidyScale(0.001), 0.01);
  assert.equal(tidyScale(-0.001), -0.01);
  assert.equal(tidyScale(99), 20);
});
