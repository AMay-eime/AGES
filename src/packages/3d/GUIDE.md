# 追加パッケージ 3d の手順（入れているプロジェクトでだけ、ages schema <dir> guide:項目 で引ける）

## 3d: 3D の位置・回転・親子とカメラ
部品: Transform3D Camera3D
- 追加パッケージ 3d は作っている途中（docs/PLAN.md の段階4）。いまあるのは位置・回転・親子とカメラの計算まで。**画面にはまだ何も描かれない**（モデル・光はこれから）。3D のゲームは、描画ができるまで作り始めない（使用者に伝える）
- 座標: Y が上・右手系・単位はメートル（glTF・three.js と同じ）。x は右、z は手前。物の「前」は +Z、カメラが見る向きは −Z
- 回転は度で、ry（左右。上から見て反時計回りが正）→ rx（上下。カメラは正で上を向く）→ rz（傾き）の順。`parent` があれば、位置・回転・倍率は親から見た値（親が消えると子も消える）
- カメラは Transform3D + Camera3D の物。`follow` に相手の ID を書くと、相手の位置 + `offset`（世界の向き）へ動き、`look` なら相手（の `lookHeight` 上）を向く。置かなければ、少し上・手前から原点を見る既定のカメラ
- ゲームのコードでは `import { worldPosition, forwardOf, lookAt, cameraOf, toScreen, screenRay, math3 } from 'ages/3d'`。`worldPosition(ctx.world, e)` は親をたどった世界の位置、`forwardOf` は前の向き、`lookAt(ctx.world, e, [x, y, z])` はその点へ向ける（カメラなら第4引数に true）。`toScreen(cameraOf(ctx.world, 幅÷高さ), 点, 幅, 高さ)` は画面の px（HUD を物の上に出すとき）、`screenRay` は画面の点から世界への光線。ベクトルと行列の計算は `math3`（add・sub・normalize・distance・lookRotation など）
- 動きはゲームのコードで書く（`t.x += vx * dt`）。物理（押し返し・重力）は本体にない
- 2D の UI（HUD・メニュー）は 3D の上にそのまま重なる。確かめは 2D と同じ（`ages run --watch player.Transform3D.x`）
