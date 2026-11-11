# 追加パッケージ 3d の手順（入れているプロジェクトでだけ、ages schema <dir> guide:項目 で引ける）

## 3d: 3D の位置・回転・親子とカメラ
部品: Transform3D Camera3D
- 追加パッケージ 3d は作っている途中（docs/PLAN.md の段階4）。いまあるのは位置・回転・親子、カメラ、基本の形と光と影、モデル（.glb）とその動き、当たり判定（重なり・線）。物理（押し返し・重力）は入れない。足りないものが要るゲームは、使用者に伝えてから進める
- 座標: Y が上・右手系・単位はメートル（glTF・three.js と同じ）。x は右、z は手前。物の「前」は +Z、カメラが見る向きは −Z
- 回転は度で、ry（左右。上から見て反時計回りが正）→ rx（上下。カメラは正で上を向く）→ rz（傾き）の順。`parent` があれば、位置・回転・倍率は親から見た値（親が消えると子も消える）
- カメラは Transform3D + Camera3D の物。`follow` に相手の ID を書くと、相手の位置 + `offset`（世界の向き）へ動き、`look` なら相手（の `lookHeight` 上）を向く。置かなければ、少し上・手前から原点を見る既定のカメラ
- ゲームのコードでは `import { worldPosition, forwardOf, lookAt, cameraOf, toScreen, screenRay, math3 } from 'ages/3d'`。`worldPosition(ctx.world, e)` は親をたどった世界の位置、`forwardOf` は前の向き、`lookAt(ctx.world, e, [x, y, z])` はその点へ向ける（カメラなら第4引数に true）。`toScreen(cameraOf(ctx.world, 幅÷高さ), 点, 幅, 高さ)` は画面の px（HUD を物の上に出すとき）、`screenRay` は画面の点から世界への光線。ベクトルと行列の計算は `math3`（add・sub・normalize・distance・lookRotation など）
- 動きはゲームのコードで書く（`t.x += vx * dt`）。物理（押し返し・重力）は本体にない（壁で止める・地面に立つ書き方は `3d-hit`）
- 2D の UI（HUD・メニュー）は 3D の上にそのまま重なる。確かめは 2D と同じ（`ages run --watch player.Transform3D.x`）

## 3d-draw: 3D の形と光
部品: Mesh3D Light3D Environment3D
- 描くのは Transform3D + Mesh3D の物。`shape` は box・sphere・cylinder・capsule・plane（上向きの板。床）。`size` は m（箱は幅・高さ・奥行き、球・円柱・カプセルは 太さ(x)・高さ(y)、板は 幅(x)・奥行き(z)）。形の中心が Transform3D の位置（高さ 1.8 のカプセルを床に立たせるなら y = 0.9）
- 見た目は `color`・`texture`（画像。`tile` でくり返す）・`roughness`（0 = つるつる、1 = つや消し）・`unlit`（光を受けない）・`alpha`（透ける）。画像を開かずに、色と大きさの数字で決める
- 光は Transform3D + Light3D。`sun` は向きだけが効く（物の前 +Z の向きに照らす。rx: 50 で斜め下、ry で方角）。`point` は位置からまわりを `range` m まで（8 つまで）。1つも置かなければ、斜め上からの既定の太陽
- 影は太陽（sun）だけが落とす（`point` は落とさない）。何も書かなくても出る。カメラから `Light3D.shadowRange` m（既定 30）まで。広い場面で遠くの影が要るなら大きく（ぼやける）、小さな場面でくっきりさせるなら小さく。影を落としたくない物（光る玉・エフェクト・空の板）は Mesh3D・Model3D の `shadow` を false に。半分より透ける物は落とさない。影の濃さは Environment3D の `ambient`（大きいほど薄い）
- 全体の明るさと霧は Environment3D（シーンに1つ。上からの色 `sky`・下からの色 `ground`・強さ `ambient`・`fog`）。空の色は画面の背景の色（ages.project.json の view.background）
- 3D は 2D の物（Sprite・Text・UI）の下に描かれる。HUD・メニューは今までどおり UI で作る
- 人はエディタの「3D シーン」パネルで、自由な視点から物を選び、ギズモで動かす・回す・大きさを変える・形や光を足す（Unity の Scene ビューにあたる。ゲームのカメラで見るのは「ゲーム」パネル）。位置の細かい調整は人に任せ、AI は大まかに置く
- 確かめ: 値は `ages run --watch`、見た目は必要なときだけ `--shot`（3D は形と位置の間違いが数字で分かりにくいので、置いた直後に1枚見るのはよい。`--shot-scale 0.5`）。`ages check` は Transform3D のない Mesh3D・Camera3D・Light3D を ⚠ で知らせる

## 3d-model: モデル（.glb）
部品: Model3D
- モデルは glTF の1つにまとまった形（`.glb`）を assets/ の下に置き、Transform3D + Model3D（`model` にファイルの場所）で描く。`.gltf` + `.bin`・FBX・OBJ は読めない（Blender などで GLB に書き出す。Kenney の3D素材は GLB 版を使う）
- **モデルを開かずに** `ages assets <dir> --kind model` で、大きさ（幅x高さx奥行き m）・中心・三角形の数・動きの名前を見る。大きさを合わせるのは Transform3D の sx・sy・sz（高さ 0.5m のモデルを 1.8m にするなら 3.6 倍）。中心の y が高さの半分なら、足元が原点（y = 0 に置けば床に立つ）
- 向きは、モデルの前が +Z（glTF の決まり）。違う向きで作られたモデルは ry で直す
- 色・画像・ざらつきはモデルの材質のまま。`color` は掛け合わせる色（白でそのまま）、`alpha` で透ける。モデルの画像が外のファイル（例 `Textures/colormap.png`）なら、モデルから見た同じ場所に置く
- 当たり判定の形はモデルからは作られない（箱・球・カプセルで近い形を付ける → `3d-hit`）
- 動き（アニメーション）: `Model3D.clip` に動きの名前を書く（名前と長さは `ages assets` の「動き: idle(1.2s) run(0.8s)」）。ゲームのコードで `m.clip = 'run'` と書き換えると、前の動きから `fade` 秒で混ざって切り替わる（毎フレーム同じ名前を書いてよい。変わったときだけ切り替わる）。`speed` は速さ（歩く速さに合わせる。0 で止まる）
- 1回だけの動き（攻撃・ジャンプ）は `loop` を false に。最後の姿勢で止まり、`done` が true になる（`if (m.done) { m.clip = 'idle'; m.loop = true; }`）。動きの途中で何かを起こすなら `time`（秒）を見る
- 名前の間違いは動かないだけなので、`ages check` が ⚠ で知らせる（シーン・プレハブに書いた clip）。確かめは `ages run --watch hero.Model3D.time,hero.Model3D.done`、形は `--shot`
- まだないもの: 骨に物を付ける（手に剣）・表情（モーフ）・2つの動きを重ねる（上半身だけ別の動き）

## 3d-hit: 3D の当たり判定（重なり・線）
部品: Collider3D
- 形は Transform3D + Collider3D（`shape` は box・sphere・capsule）。`size` は Mesh3D と同じ書き方なので、同じ数字を書けば見た目と合う。モデルは `ages assets` の大きさを `size`、中心を `offset` に書く（足元が原点のキャラクターなら、高さ 1.8 のカプセルを `offset: [0, 0.9, 0]`）。`group` に名前（player・wall・coin…）
- 調べるのはゲームのコードで `import { hit3 } from 'ages/3d'`（group は名前か、その並び。省くと全部。結果はワールドに入った順）
  - `hit3.overlaps(ctx.world, id, group?)` いま重なっている相手の ID ／ `hit3.test(ctx.world, a, b)` 2つが重なっているか
  - `hit3.sphere(ctx.world, [x, y, z], r, group?)`・`hit3.box(ctx.world, 中心, [幅, 高さ, 奥行き], group?)`・`hit3.point(ctx.world, [x, y, z], group?)` 範囲・点にある物
  - `hit3.ray(ctx.world, from, to, group?)` 線分で最初に当たる物 `{ id, point, normal, dist }`（なければ null。見通し・弾・足元の地面）
  - `hit3.entered(ctx.world, id, group?)` 重なり始めた相手（自分の Collider3D の `with` に相手のグループを書いておく。1回だけ拾う・踏んだ瞬間に）
- **押し返し・重力は本体にない。ゲームのコードで書く**（見本のゲームに同じ書き方がある）:
  - 壁で止まる: x だけ動かして `hit3.overlaps(ctx.world, id, 'wall').length` なら x を戻す。z も同じ（別々に試すので、壁に沿って滑る）
  - 地面に立つ: 足元より少し上から下へ `hit3.ray(ctx.world, [x, y + 1, z], [x, y - 0.2, z], 'ground')`。当たれば `t.y = hit.point[1]` で立たせ、当たらなければ落とす（`vy -= 20 * ctx.dt`）
- 確かめ: `ages run --watch player.Collider3D.touching`（`with` のグループと、いま重なっている相手）。`ages check` は、`with` に書いたグループを誰も名乗っていないと ⚠ で知らせる
- 人はエディタの「3D シーン」で当たり判定の形を緑の線で見られる。「＋ 足す」→「当たり判定を、選んだ物の形に合わせて付ける」で、選んだ形・モデルに合う大きさで付く
