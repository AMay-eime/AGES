// 追加パッケージ 3d（公式）。ゲームのコードからは import { … } from 'ages/3d'。
// ages.project.json の packages に "3d" を書いたプロジェクトでだけ読み込まれる。
// 作る順番は docs/PLAN.md の段階4（いまは位置・回転とカメラまで。描画はこれから）
import { definePackage } from '../../core/packages.ts';
import { COMPONENTS_3D } from './components.ts';
import { SYSTEMS_3D } from './systems.ts';

export { Transform3D, Camera3D } from './components.ts';
export * as math3 from './math.ts';
export type { Vec3, Mat4 } from './math.ts';
export { matrixOf, worldPosition, forwardOf, lookAt, cameraOf, toScreen, screenRay, worldMatrix, localMatrix, type CameraView3, type Pose3 } from './space.ts';

export default definePackage({
  name: '3d',
  desc: '3D（作っている途中。いまは位置・回転とカメラまでで、画面にはまだ何も描かない）',
  components: COMPONENTS_3D,
  systems: SYSTEMS_3D,
  toc: [
    '3D の位置・回転・親子とカメラ: Transform3D・Camera3D と `ages/3d` の worldPosition・lookAt・toScreen。Y が上・単位は m・物の前は +Z → `3d`',
  ],
});
