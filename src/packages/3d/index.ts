// 追加パッケージ 3d（公式）。ゲームのコードからは import { … } from 'ages/3d'。
// ages.project.json の packages に "3d" を書いたプロジェクトでだけ読み込まれる。
// 作る順番は docs/PLAN.md の段階4
import { definePackage } from '../../core/packages.ts';
import { COMPONENTS_3D } from './components.ts';
import { CHECKS_3D, SYSTEMS_3D } from './systems.ts';
import { createLayer3D } from './render.ts';

export { Transform3D, Camera3D, Mesh3D, Model3D, Light3D, Environment3D, Collider3D } from './components.ts';
export { hit3, shapeOf, shapeFrom, overlap3, contains3, rayHit3, sphereShape, boxShapeAt, type Shape3, type RayHit3 } from './collide.ts';
export * as math3 from './math.ts';
export type { Vec3, Mat4 } from './math.ts';
export { pickSolids, hitSolid, type Ray, type Solid } from './pick.ts';
export { matrixOf, worldPosition, forwardOf, lookAt, cameraOf, toScreen, screenRay, worldMatrix, localMatrix, type CameraView3, type Pose3 } from './space.ts';

export default definePackage({
  name: '3d',
  desc: '3D（作っている途中。基本の形・光と影・カメラ・モデル（.glb）とその動き・当たり判定まで。物理は入れない）',
  components: COMPONENTS_3D,
  systems: SYSTEMS_3D,
  checks: CHECKS_3D,
  render: createLayer3D,
  editor: true,
  toc: [
    '3D の位置・回転・親子とカメラ: Transform3D・Camera3D と `ages/3d` の worldPosition・lookAt・toScreen。Y が上・単位は m・物の前は +Z → `3d`',
    '3D の形と光と影: Mesh3D（箱・球・円柱・カプセル・板）・Light3D（太陽・点。影は太陽だけ）・Environment3D（全体の明るさ・霧） → `3d-draw`',
    'モデル（.glb）と動き: Model3D（clip で動きを再生・切り替え）。大きさ・中心・動きの名前は `ages assets` で見る（開かない） → `3d-model`',
    '3D の当たり判定: Collider3D（箱・球・カプセル）と `ages/3d` の hit3（重なり・範囲・線）。押し返し・重力はゲームのコードで → `3d-hit`',
  ],
});
