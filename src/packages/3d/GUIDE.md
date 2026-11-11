# 追加パッケージ 3d の手順（入れているプロジェクトでだけ、ages schema <dir> guide:項目 で引ける）

## 3d: 3D の位置・回転・親子とカメラ
部品: Transform3D Camera3D
- 追加パッケージ 3d は作っている途中（docs/PLAN.md の段階4）。いまあるのは位置・回転・親子、カメラ、基本の形と光まで。モデル（glTF）・アニメーション・影・当たり判定はまだない。足りないものが要るゲームは、使用者に伝えてから進める
- 座標: Y が上・右手系・単位はメートル（glTF・three.js と同じ）。x は右、z は手前。物の「前」は +Z、カメラが見る向きは −Z
- 回転は度で、ry（左右。上から見て反時計回りが正）→ rx（上下。カメラは正で上を向く）→ rz（傾き）の順。`parent` があれば、位置・回転・倍率は親から見た値（親が消えると子も消える）
- カメラは Transform3D + Camera3D の物。`follow` に相手の ID を書くと、相手の位置 + `offset`（世界の向き）へ動き、`look` なら相手（の `lookHeight` 上）を向く。置かなければ、少し上・手前から原点を見る既定のカメラ
- ゲームのコードでは `import { worldPosition, forwardOf, lookAt, cameraOf, toScreen, screenRay, math3 } from 'ages/3d'`。`worldPosition(ctx.world, e)` は親をたどった世界の位置、`forwardOf` は前の向き、`lookAt(ctx.world, e, [x, y, z])` はその点へ向ける（カメラなら第4引数に true）。`toScreen(cameraOf(ctx.world, 幅÷高さ), 点, 幅, 高さ)` は画面の px（HUD を物の上に出すとき）、`screenRay` は画面の点から世界への光線。ベクトルと行列の計算は `math3`（add・sub・normalize・distance・lookRotation など）
- 動きはゲームのコードで書く（`t.x += vx * dt`）。物理（押し返し・重力）は本体にない
- 2D の UI（HUD・メニュー）は 3D の上にそのまま重なる。確かめは 2D と同じ（`ages run --watch player.Transform3D.x`）

## 3d-draw: 3D の形と光
部品: Mesh3D Light3D Environment3D
- 描くのは Transform3D + Mesh3D の物。`shape` は box・sphere・cylinder・capsule・plane（上向きの板。床）。`size` は m（箱は幅・高さ・奥行き、球・円柱・カプセルは 太さ(x)・高さ(y)、板は 幅(x)・奥行き(z)）。形の中心が Transform3D の位置（高さ 1.8 のカプセルを床に立たせるなら y = 0.9）
- 見た目は `color`・`texture`（画像。`tile` でくり返す）・`roughness`（0 = つるつる、1 = つや消し）・`unlit`（光を受けない）・`alpha`（透ける）。画像を開かずに、色と大きさの数字で決める
- 光は Transform3D + Light3D。`sun` は向きだけが効く（物の前 +Z の向きに照らす。rx: 50 で斜め下、ry で方角）。`point` は位置からまわりを `range` m まで（8 つまで）。1つも置かなければ、斜め上からの既定の太陽。影はまだ落ちない
- 全体の明るさと霧は Environment3D（シーンに1つ。上からの色 `sky`・下からの色 `ground`・強さ `ambient`・`fog`）。空の色は画面の背景の色（ages.project.json の view.background）
- 3D は 2D の物（Sprite・Text・UI）の下に描かれる。HUD・メニューは今までどおり UI で作る
- 人はエディタの「3D シーン」パネルで、自由な視点から物を選び、ギズモで動かす・回す・大きさを変える・形や光を足す（Unity の Scene ビューにあたる。ゲームのカメラで見るのは「ゲーム」パネル）。位置の細かい調整は人に任せ、AI は大まかに置く
- 確かめ: 値は `ages run --watch`、見た目は必要なときだけ `--shot`（3D は形と位置の間違いが数字で分かりにくいので、置いた直後に1枚見るのはよい。`--shot-scale 0.5`）。`ages check` は Transform3D のない Mesh3D・Camera3D・Light3D を ⚠ で知らせる
