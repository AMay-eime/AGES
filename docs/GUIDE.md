# AGES の機能ごとの手順（要るときに引く）

AIが毎回読む AGENTS.md には、機能ごとに1行の目次だけを置く。詳しい手順はここに書き、`ages schema <dir> guide:<項目>`（MCP なら ages_schema に `guide:<項目>`）で、その機能を使うときだけ引く。
`## 項目: 題` の形で書く。`部品:` の行は、その項目で使う標準のコンポーネント（`ages schema <dir> UI` などに「使い方」として出る）。

## table: 表（同じ形の行がたくさん並ぶデータ）
- 武器・敵・カードなど、同じ形の行が並ぶデータは表にする。形は `defineTable`、中身は `data/<表>.table.json`
- 住所は `$表.行.列`。読むのは `ages table <dir> <表>`（`--cols` `--rows` で絞る。`--empty 列` でその列が空の行だけ）
- 行は patch の `addRow` / `removeRow` / `moveRow` / `renameRow`（名前を変えると、その行を指している値も直る）
- ゲームのコードは `ctx.table(形).get(ID)`
- 表計算ソフトと行き来するときは `ages table <dir> <表> --export x.csv` / `--import x.csv`（読み込みは表をまるごと置き換える）
- 標準の表 `$actions`（操作）・`$tweens`（トゥイーン）・`$text`（言葉）の列は `ages schema <dir> $actions` などで見る
- 列（フィールドも）の型で、エディタの欄が決まる: 文字の `multiline: true` は複数行の欄（台詞など）、プレハブの `tags: ['stage']` は選ぶ一覧をそのタグのプレハブに絞る

## prefab: プレハブと派生・インスタンス
- プレハブ（`@名前`）は、コードから `ctx.spawn('名前')` で出す物のひな形。作る・消す・名前を変えるのは patch の `addPrefab` / `removePrefab` / `renamePrefab` / `setPrefab`（ファイルを直接作らない。名前を変えると prefab 型の値・派生の元・🔒★も直る。コードの中は直らないので ⚠ に従って直す）
- 似た物（速い敵・硬い敵など）は、写すより派生にする: `{"op":"addPrefab","name":"enemy_fast","base":"enemy","components":{"Velocity":{"vy":6}}}`。元の値を受け継ぎ、書いた値だけが変わる。元を直すと、派生の変えていない値も一緒に変わる
- 派生の値もふつうの住所で読み書きする（`@enemy_fast.Velocity.vy`）。変えた値は フィールドごと（リスト・構造体は丸ごと）。元と同じ値にすると「受け継ぐ」に戻る
- 元の値に戻すのは `{"op":"revert","path":"@enemy_fast.Velocity.vy"}`（部品ごとなら `@enemy_fast.Velocity`。外した部品も戻る）。派生でない物の revert は既定値に戻す
- 元から部品を外すのは `removeComponent`、足すのは `addComponent`。切り離す（ふつうのプレハブにする）のは `setPrefab` の `base: null`（値は変わらない）
- 地図の `@x ← @元` が派生、`変:` が元から変えた所。受け継いだ値にロックが付いていると、元を変えてその値が変わる編集は止まる
- シーンに置く物も、プレハブから作ればつながる（インスタンス）: `{"op":"addEntity","scene":"main","entity":{"id":"boss","prefab":"enemy","components":{"Transform":{"x":100,"y":50}}}}`。ファイルにはプレハブと違う値だけが残り、プレハブを直すと変えていない値も一緒に変わる。読み書き・revert・外す/足すは派生と同じ（住所は `main#boss.Health.hp`）
- 置いてある物をプレハブにつなぐ・切り離すのは `linkPrefab`（`{"op":"linkPrefab","target":"main#boss","prefab":"enemy"}`・`prefab: null`。どちらも値は変わらない）。地図の `#boss ←@enemy` がインスタンス、`変:` がプレハブから変えた所
- 数値だけが違う行がたくさん並ぶなら、派生より表（table）が向く
- **子を持つプレハブ**（Unity の子を持つプレハブ）: 自機に武器・銃口の光のように、いつも一緒に出る物の組は子にする（組み立て用のシーンを作って ID で探さない）。`{"op":"addPrefab","name":"ship","components":{…},"children":[{"name":"gun_l","prefab":"gun","components":{"Transform":{"x":-12}}},{"name":"core","components":{"Transform":{"y":2},"Shape":{…}}}]}`
  - `prefab` を書いた子は、そのプレハブを子にして `components` は変えた値だけ（`children` もその子の値を変えるだけ）。書かなければ `components` が子の中身そのもの。子の子も書け、深さに上限はない
  - `ctx.spawn('ship')` で親・子・孫がまとめて出る。子の ID は `親のID/名前`、位置（Transform）は親から見た値で、親が消えると子も消える。コードからは `ctx.child(親, 'gun_l')`（孫は `'gun_r/muzzle'`）
  - 子の値は `@ship/gun_l.Transform.x`・`@ship/gun_r/muzzle.Shape.color` で読み書きする（get・set・ロック・`--watch` も同じ住所）。子にしたプレハブを直すと、変えていない子の値も変わる
  - 今あるプレハブの子は `addChild`（`{"op":"addChild","parent":"@bg","child":{"name":"mist","components":{…}},"index":1}`。`parent` を `@bg/mist` にすると孫）・`removeChild`・`renameChild`・`moveChild`（並び＝同じ層なら描く順。`parent` で親も変える、値はそのまま）で足し引きし、子の部品は `addComponent`・`removeComponent`（target `@bg/mist`）。作り直さない。派生・置いた物がその子に書いた値は名前で付いてくる（消すと値も消え、結果に並ぶ）
  - 足し引きは子を決めているプレハブでだけ。派生・置いた物は子の値を変えるだけ。別のプレハブを子にした所（`@ship/gun_l`）の中は、そのプレハブ（`@gun`）で足し引きする（使っている所すべてに出る）
  - シーンに置いたインスタンスの子は、置いた物ごとに値を変えられる: `main#boss/gun_l.Transform.x`（値はシーンのその物の `children` に、変えた値だけ入る。プレハブを直すと、変えていない値は伝わる）。置いた物ごとの子の足し引き・切り離し（linkPrefab null）はできない
  - 人はエディタのアセットの画面の「🧩 プレハブ」（タグごと・名前の頭でまとめる）から、プレハブを開いて（ダブルクリックか「開く」）、親と子がそろった絵で子を選び、インスペクタとドラッグで直せる。子の足し引き・名前・並べ替え・複製は階層の右クリックと＋、アセットやプレハブを階層へ運ぶと子になる
- **まつわる値**（`params`）: エディタでプレハブを選ぶと、そのプレハブにまつわる表の値が並び、その場で直せる（値は表のまま。ロックも同じ）。並べる値は AI が決める: `{"op":"setPrefab","name":"enemy_fast","params":["$enemies.fast","$waves.w3.interval"]}`（`$表.行` は行の列すべて、`$表.行.列` はその値）。書いていなければ、そのプレハブを指す表の行（`prefab` の列）が出る。プレハブを作ったら、人がよく触る表の値を並べておき、使用者に「足りない・要らない」と言われたら足し引きする
- プレハブだけを試すのは `ages run <dir> --spawn enemy_fast`（空のシーンの真ん中に出し、消えたら止まる。`explosion@40,0` で真ん中からずらす。音のプレハブは1回鳴らす）。人はエディタの「試し」の窓で同じものを見る
- 実行中にプレハブから出た物の値を見るのは `ages run --watch @プレハブ名.部品.値`（いる最初の1つ）。全部は `@弾[*].部品.値`（ID ごと）、値で絞るのは `@弾[kind=pierce].部品.値`（合う最初の1つ。`[*kind=pierce]` で合う物全部、`!=` も）
- 出来事（`ctx.emit`）の中身は `ages run --log 名前,…`（出たフレームと中身を1行ずつ。`*` で全部）。確かめのためにゲームのコードへ `console.log` を足さない
- 小さい物の見た目は `--shot 600 --shot-around player,80x80,x4`（物か @プレハブ名か 画面の点 x:y のまわりを切り抜いて、整数倍に。にじまない）。時間の変化（点滅・回転）を **AI が自分で**確かめるのは `--shot 361-421:4 --shot-sheet`（4フレームごとに撮って、番号つきで1枚に並べる。around と一緒に使える）。並べた1枚は AI の確認用で、人に見せるものではない（人には `review`）。3D の物は `ages space` で画面の位置を見て x:y で

## sprite: 画像・図形・コマ・動き・切り抜き
部品: Sprite Animator Shape Clip
- 画像はプロジェクト内のパスで指定する（`Sprite.image: "assets/x.png"`）。コマは `Sprite.frame`（番号か名前）、動きは `Animator.clip`（標準のシステム std.animator が進める）
- 切り方は `ages sheet <dir> <画像>` で見る。画像を開いて確かめない（何コマあるかは地図にも出る）
- 切るのは `ages slice <dir> <画像> --grid 32x32 | --count 4x6 | --auto`（`--dry` で保存せずに確かめる。前と同じ場所のコマは名前を引き継ぐ）
  - 格子の `--skip-empty`（何も描かれていないコマを除く）。auto の `--gap`（この距離 px 以内は1コマにまとめる）・`--min`（これより小さいものは捨てる px）・`--pad`（矩形を外へ広げる px）。`--pivot 0.5,1` は新しいコマの基準点（下の中央）
- 1コマ・1動きの変更は patch の `setFrame` / `setClip`（例 `{"op":"setFrame","image":"assets/x.png","frame":"x_3","name":"hero_idle","pivot":[0.5,1]}`）。`.sheet.json` を直接書き換えない
- コマを指定するときは名前を使う（切り直してもずれない）。切り方の🔒・★はシーンの値と同じ扱い
- 図形は Shape。四角・円は `stroke` を1以上にすると枠（リング・ゲージの枠）、中は `fill` で塗る（既定は透明）。線は `kind: "line"` で、物の位置から `to`（ずれ。回転がかかる）まで、太さは `stroke`。レーザー・予告線は線の物を1つ置き、`to` か `Transform.rot` を変える（細い四角を計算しない）
- 破線は `dash: [線の長さ, すきま]`（線と枠）。`dashOffset` をトゥイーンで変えると模様が流れる（選んだ範囲の枠・エディタのギズモ）。色は `#rrggbbaa` の aa で透ける（半透明の塗り）
- 絵を伸ばさずに並べるのは `Sprite.tile`（1枚の大きさ）と `size`。`tileOffset` を毎フレーム変えると流れる（帯のレーザー・背景・床）。光るものは Sprite・Shape の `blend: "add"`
- 決めた四角の中だけに描くのは Clip（`min`・`max`。背景の切り替えの境目・巻物の一覧）。画面を分けて別のものを映すなら Camera の viewPos・viewSize（guide:camera）

## camera: カメラと画面の大きさ
部品: Camera
- カメラは標準の Camera（`ages schema <dir> Camera`）。追いかけ・範囲の制限・揺れは自分で書かない（標準のシステム std.camera が動かす）。揺らすのは `ctx.shake(0〜1)`
- 画面の大きさへの合わせ方は `ages.project.json` の `view.fit`。ゲームのロジックは `ctx.view`（設計の大きさ）だけを使う

## transform: 位置の親子（親と一緒に動く・回る）
部品: Transform
- 子の `Transform.parent` に親の ID を書くと、子の x・y・rot・sx・sy は親から見た値になり、親と一緒に動く・回る・大きくなる（Unity と同じ）。親が鏡写し（倍率が負）なら子の向きも逆
- 画面（ワールド）の位置が要るとき（狙う・距離・弾を出す位置）は `ctx.worldOf(物)`（{ x, y, rot, sx, sy }。親がなければ Transform と同じ）。子の `t.x` をそのまま画面の位置として使わない
- 画面のこの位置に置くのは `ctx.setWorldPos(物, x, y)`（向き・大きさも決めるなら `ctx.setWorld(物, { x, y, rot, sx, sy })`。渡した値だけ）。親を変えるのは `ctx.attach(子, 親)`（null で親なし。画面の位置・向き・大きさはそのまま）
- 実行中に親付きで出すのは `ctx.spawn('part', { Transform: { parent: boss.id, x: 30, y: 0 } })`（x・y は親から見た位置）
- 親が消えると子も孫も一緒に消える（残したい子は先に `ctx.attach(子, null)`）。見せるか（visible）や描く層は親と別
- 描画・当たり判定・カメラ・パーティクル・エディタの印とドラッグは画面の位置を使う。エディタの階層では親の中に並び、運んで親を変えても画面の位置はそのまま
- UI の物は UI.parent（親の四角の中に置く）を使い、Transform.parent は使わない

## sound: 音
部品: Sound AudioBus
- 音は Sound の付いたプレハブ（例 `@se_shot`）を作り、`ctx.sound.play('se_shot')` で鳴らす。音量などの調整値はプレハブに置き、コードに書かない
- BGM・環境音は物に Sound（playOnStart）を付ける（標準のシステム std.audio が、物が現れたら鳴らし、消えたら止める）
- 音量の区分はゲームに合わせて AudioBus のプレハブで作る（例 `@bgm` exclusive、`@se`）。どんな区分にするかは EDITOR-PLAN.md で使用者と決める
- 鳴ったかどうかは `ages run` の `sounds:` と ⚠ で確かめる（音を聞かなくてよい）

## input: 入力とキーコンフィグ
- 入力は操作の名前で読む（`ctx.input.isDown('fire')` / `pressed` / `value('move_x')`）。キーの名前をコードに書かない
- 操作と既定の割り当ては標準の表 `$actions`（`ages table <dir> actions`）に行を足す
- キーコンフィグの画面はゲームのスクリプトで作る: `ctx.input.bind(操作, { keys: [...] })` / `resetBindings()` / `lastPressed()` / `usedBy(ボタン)` / `label(ボタン)`。割り当ては自動で保存される（save を参照）
- マウス・タッチの位置は `ctx.input.pointer`（画面の座標）か `ctx.pointerWorld()`（ワールドの座標）
- `ages run --keys` の書き方: `開始-終了:入力+入力`（終了のフレームで離す。**終了を省くと、最後まで押したまま**。1回だけ押すなら `80-81:@jump`）。`@操作`、`@操作=-1`（− の向き）、`@操作=0.5`（アナログ）、`KeyZ` などのボタン、`Pad.LX=0.7`（軸）、`ptr=240,100`（マウスの位置）、`wheel=1`、`click=x,y` / `click=ボタンのID`（1フレームだけ押す）
- `シーン名+開始-終了:入力` は、そのシーンに入るたびに、入ってからのフレームで押す（例 `title+30:click=start;result+40-41:@ui_confirm`。メニューを通る流れを、いつ入るか数えずに書ける。入らなかったシーンは ⚠）

## event: システムどうしの連絡（出来事）
- あるシステムで起きたことを、ほかのシステムに知らせるのは `ctx.emit('enemyKilled', { id, score })`。受けるシステムは `defineSystem({ name, desc, on: { enemyKilled(ctx, data) { ... } } })`
- 受ける側は emit のその場で呼ばれる（同じフレームのうちに。このシーンで動くシステムだけ、実行順に）。出す側に、受ける側の呼び出しを書き込まない（ストーリー・実績・音・演出を戦闘のコードに混ぜない）
- 返事が要るとき（「時間を回復しない」など）は、受けた側が data を書きかえ、出した側が emit の後で読む（例 `const got = { kind, addTime: true }; ctx.emit('itemCollected', got); if (got.addTime) …`）
- 受けるだけのシステムは update を省ける。標準の出来事は `scene`（{ from, to }。シーンが変わった直後）と `ui.click`（{ id }）。トゥイーンの `emit` も同じように受けられる
- 地図のシステムの行の `受ける:` で、どのシステムが何を受けるかが分かる（`ages find 出来事の名前` でも引ける）。出した回数は `ages run` の `events:`
- 受けた先でまた出してもよいが、16段を超える（出来事が輪になっている）とエラーで止まる
- 受けている出来事を、コードのどこからも出していない（`ctx.emit('名前')` もトゥイーンの `emit` もない）と、`ages check` が ⚠ で知らせる。名前の書き間違いは型チェックで見えず、動かしても何も起きないだけなので、動かす前にここで見つける

## date: 日時（日付を使う遊び）
- 今の日時は `ctx.date`（year month day hour minute second weekday ms）。`Date` を使わない
- 実際の時計から取るのは始めた時刻だけで、そこからはゲームの中の時間で進む（同じ入力なら同じ結果）。毎日の報酬などで日をまたいだかは、保存した日付と比べる
- `ages run` は決まった日時（2026-01-01 12:00）で始める。変えるのは `--date 2026-12-25T09:00`。ctx.date を読むと要約に `date:` が出る。入力の記録には始めた日時が残り、`--input` で同じ日時になる

## scene: シーン
- 切り替えは `ctx.scene.goto('名前', { fade, params })`、次のシーンで `ctx.scene.params`。切り替えても残す物には tag `keep`
- そのシーンでだけ動くシステムには `scenes: ['名前']`。確かめるのは `ages run --until scene:名前`
- 前のシーンから params を受け取るシーンを、そのシーンから確かめるのは `ages run --scene 名前 --params stage=s1,level=2`
- シーンを作る・消す・名前を変える・開始にするのは patch の `addScene` / `removeScene` / `renameScene` / `setScene`（ファイルを直接作らない。名前を変えると参照とロックも直る）

## assets: アセット（画像・音・フォント）
- 一覧と使っている所は `ages assets <dir>`（`--unused` で使っていないもの、`--refs 場所` で使っている所）。画像を開いて確かめない
- アセットが多い（40個より多い）と、地図にはフォルダごとの数だけが出る。1つずつは `ages assets <dir> assets/images/Enemies` のようにフォルダで引く
- 場所を変える・消すときは、ファイルを直接動かさず patch の `moveAsset` / `removeAsset`（使っている値と切り方も直る。使われているものは消せない）
- 新しいファイルは assets/ の下に置くだけでよい。`🔒ファイル` の付いたアセットは、差し替え・移動・削除ができない
- **出どころを書く**: アセットを足したら、そのときに `ages assets <dir> --origin <ファイル | フォルダ> --by own|ai|stock|commission`（自作・AI 生成・配布や購入の素材・人に頼んだ）。AI が作った画像・音は `--by ai --tool 使った AI の名前`、素材集は フォルダごとに `--by stock --license CC0 --from "作者・URL"`。MCP は ages_assets の `origin: { path, by, tool, license, from, note }`（`origin: true` で一覧）
- 出どころは、ストアの申告（プレイヤーに届く物に生成 AI を使ったか。翻訳も入る）とクレジットのための記録（`assets.origin.json`。Git で共有）。使用者に聞かないと分からないもの（前からあるファイルなど）は、推測で書かずに聞く。AI に翻訳させた言語は `--origin '$text.en' --by ai --tool …`
- 未記入は `ages check` と書き出しで ⚠ が出るだけで、止まらない。一覧は `ages assets <dir> --origin`（★ は人が書いた記録。変えるには人に確かめて `--force`）。`moveAsset` で場所を変えると、記録もついていく

## tween: 値を時間で変える演出
- 点滅・はねる・薄くして消すなどは `ctx.tween(物, { 'Sprite.alpha': 0 }, '名前')`。自分でフレームを数えない
- 手触り（秒数・ease・くり返し）は標準の表 `$tweens` に行を足して名前で使い、コードに数字を書かない
- `'+10'` で今の値からの相対、`from` で始めの値、`destroy` / `emit` で終わったときの処理。止めるのは `ctx.stopTween`
- 動いているトゥイーンは `ages run` の `tweens:` に出る

## shader: 見た目の効果（シェーダー）
部品: Effect PostEffect
- 光らせる・縁取り・溶かす・画面の端を暗くするなどは、物に Effect（その物）か PostEffect（画面全体）を付けて `shader` を選ぶ
- まず標準の `std:flash` `std:outline` `std:dissolve` `std:desaturate` `std:vignette` `std:crt` で足りるか考える（値の一覧は `ages schema <dir> std:flash` など）
- 値は `params.名前`（patch の住所も `…Effect.params.amount`）。動かすのは `ctx.tween(id, { 'Effect.params.amount': 0 }, '名前')`
- 後処理を UI のカメラにかけたくないときは `PostEffect.camera` にゲームのカメラの ID
- Effect は1つの物に1つなので、重ねたい効果は1つのシェーダーにまとめて書く
- 新しいシェーダーは assets/ の下に `.frag` を置く。書くのは `vec4 effect(vec4 c, vec2 uv)` と、`uniform float x; // 0..1 =0 説明` の形の宣言だけ（書き方と手本は `ages schema <dir> std:flash`）
- エディタを開いていればコンパイルの結果が `ages check` に「ファイル:行」で出るので、画面を見ずに直せる

## ui: 画面に固定するもの（HUD・メニュー・ボタン・ゲージ）
部品: UI Layout Button Gauge
- 物に UI を付けてシーンに置く。コードで画面を組み立てない（人がエディタで配置を直せるように）
- 置き方は `UI.anchor`（画面の9か所）と x・y・w・h、並べるのは親に Layout。ボタンは Button を付け、コードは `ctx.ui.clicked('ID')` を読むだけ。体力などは Gauge（drag ならスライダー）
- 配置を直すよう頼まれたら、座標を計算せずに patch の `dockUI`（画面・親の端や角に付ける）か `attachUI`（別の UI の隣に接して置く。重ならず、相手と一緒に動く）。書き方は `ages schema <dir> ops`
- 直した後は `ages ui <dir> <シーン>` で、重なり・はみ出しの ⚠ がないことを確かめる
- 押したかは `ages run --keys "300:click=ボタンのID"` と要約の `ui:` で確かめる（画面を見なくてよい）

## hit: 当たり判定
部品: Collider
- 標準の Collider（円・矩形、グループ名）を付け、`ctx.hit.overlaps(id, 'enemy')` などで調べる。距離の計算を自分で書かない
- 重なり始めを記録する相手は `with` にグループ名で書く。当たったかは `ages run` の `hits:` で確かめる
- 押し返し・跳ね返りが要るゲームは、プロジェクトの中で作る

## text: 画面に出す言葉と多言語
部品: Text
- 画面に出す言葉は、コードに直接書かず表 `$text` の行にする（`ctx.t('名前', { 値 })`。決まった言葉なら Text.key に行の名前）
- 言語を足すのは `ages.project.json` の languages（最初が既定）。切り替えは `ctx.setLang('en')`
- 未訳は `ages table <dir> text --empty en` で探して表に入れ、`ages run --lang en` で確かめる
- 背景の上で読ませる文字（HUD・ダメージの数字）は `Text.outline`（縁取りの太さ）と `outlineColor`、`bold`。シェーダーの std:outline より軽い

## save: 保存
- `ctx.save.get/set`（最高得点・進み具合）。物ごとまとめて残すなら `saveWorld(key, { tags: ['save'] })` / `loadWorld(key)`（型が変わっても戻せる）
- キーの割り当て・音量・言語は自動で保存されるので書かない
- 保存がある状態は `saves/x.save.json` を置いて `ages run --save saves/x.save.json` で確かめる（`--save-out` で終わりの状態を書き出す）

## particles: 粒（火花・煙）
部品: Particles
- 標準の Particles を物（プレハブ）に付ける（`ages schema <dir> Particles`）。現れたときに出すのは `burst`、出し続けるのは `rate`。後から出すのは `ctx.particles.burst(id)`
- 粒の動きは描く側で動かし、ゲームの結果には入らない。出したかどうかは `ages run` の `particles:` で確かめる

## window: プロジェクト独自のエディタ拡張（パネル・インスペクタと表の欄・部品・行の見せ方）
- **作る前に地図の `## editor extensions` を見る。** 近いものがあれば、新しく作らずにそれを直す（拡張が増えすぎないように）
- `editor/<名前>.ext.ts` に `defineExtension` で書き、`ages.project.json` の `editorWindows` に追加する。窓口は要る分だけ:
  - `panel: { title, area?, mount(el, api) }` 調整用の画面（例 `examples/shooter/editor/wave-tuner.window.ts`。パネルだけなら `defineWindow` でもよい）
  - `fields: [{ match, mount(el, field, api) }]` インスペクタと表のエディタの欄の見せ方。match は 型（`'color'`）・部品.フィールド（`'Health.hp'`）・`$表.列`（`'$talks.face'`。どの行にも）・住所（`'main#player.Health.hp'`）。入れ子の中は `[]` と `.名前`（`'Stage.elements[].enemy'`・`'$talks.lines[].face'`）。`field.value` を見せ、`field.set(値)` で変える。`field.standard()` で標準の欄も並べられる。入れ子の中なら `field.parent`（すぐ外の値）、表なら `field.row`（例 `examples/shooter/editor/hp-hearts.ext.ts`）
  - `components: [{ component, hide?, mount(el, comp, api) }]` 部品の欄の上に中身を足す。`hide: 'all'` か名前の並びで標準の欄を隠す。`comp.set(フィールド, 値)`（例 AGES 本体の `src/editor/builtin/ui-dock.ts`）
  - `rows: [{ table, hide?, mount(el, row, api) }]` 表のエディタで行を選んだときの右の欄の上に中身を足す（部品の見せ方の表版。`row.values` は既定値で埋めた行、`row.set(列, 値)`・`row.locked(列)`）。表の一覧は標準のまま、行の中身だけを作る
  - `menus: [{ label, where: 'entity', when?(targets, api), run(targets, api) }]` シーンの物の右クリックのメニュー。targets は選んでいる物の住所（例 AGES 本体の `src/editor/builtin/entity-menu.ts`）。`where: 'prefab'` はアセットの画面のプレハブの右クリック（targets は `['@名前']`。例 `prefab-menu.ts`）
- `desc`（何のためか、1行）を必ず書く。パネルがあるなら `title` と `edits`（パネルが変える値の住所。`main#spawner.Spawner.*` のようにまとめても書ける）も。地図にはこの宣言が1行で出る
- プレハブを作る・写す・名前を変える・消す拡張は `edits: ['@[enemy]']`（タグ enemy のプレハブすべて。派生が受け継いだタグも数える）。addPrefab（copy・base も）・renamePrefab・setPrefab・removePrefab・部品の付け外し・revert と中の値、子（孫も）の値・足し引き・名前・並べ替え・親の変更を変えられる（`@名前` も同じ）。対象は変える前からそのタグを持つプレハブと新しく作るプレハブで、変えた後もタグを持つこと（作るときは tags を書くか、タグを持つものを copy・base に）。値だけなら `@[enemy].Enemy.*`。表の行の追加・削除・名前・並びは `$表.*`
- 拡張から変えられるのは、`edits` に書いた値と、見せている欄（その中も）・部品・行の値だけ。🔒ロックされた値は拡張からは変えられない。ロックの操作を拡張に作らない（作っても、サーバーが受け付けない）
- 値を変えるのは `api.patch`・`field.set`・`comp.set`・`row.set` だけ（エディタのサーバーを直接呼ばない）。読むのは `api.get`（派生は元と重ねた値）、知らせるのは `api.notify(文, 'warn')`、画像の切り方は `api.sheet(画像)`、選んでいる物は `api.selection`（すべては `api.selected`。`api.select(住所, true)` で足す。表のエディタで選んだ行は `$表.行`、`api.select('$表.行')` で表をその行で開く。変わると `api.on('select')`）、1行を尋ねるのは `await api.ask(題, 既定)`
- `api.patch` は拡張ごとに1つずつ順に送る。前の変更の後の値から次の変更を作るとき（続けてのクリック・ドラッグ）は、関数で渡す: `api.patch(() => [{ op: 'set', path, value: 今の値から }])`（前の変更が終わってから、その時の `api.get`・`api.table` で作る）。既定値は `defaultOf(型)`、op の型は `Op`（どちらも `ages` から）
- 拡張の見た目は `defineExtension({ css: '…' })`（クラスの名前は拡張の id から始める。document.head に自分で style を足さない）。欄の見せ方から、その欄を名前の行ごと隠すのは `field.hide()`。パネルは人がタブの ↗ で別のウインドウに出せる（中身は元のエディタのまま動く）。パネルの中の要素は `el` から探す（`document.getElementById` などは、別のウインドウに出すと見つからない）。`window`・`document` で待つマウス・キーは、別のウインドウからも届く
- `api.run` の `onEvent(ev)` で出来事の中身（data）を読める（例 stageElement の番号と時刻）。`onFrame(game, ids)` の ids は spawn で出した物。重いシーンの舞台は `resolution: 0.5` で軽くなる。`api.show` は相手の拡張がいなければ false
- パネルの中に標準の欄（数・選択・プレハブ・アセット・表の行・色・入れ子）を置くのは `api.input(型, 値, (値, final) => …)`。同じ欄を手で作らない
- プレハブを派生も重ねた形で（受け継いだタグ込みで）読むのは `api.prefabs(タグ)`（`api.state.prefabs` はファイルの中身のまま）。`api.get('@x.部品')` は書いていないフィールドを既定値で埋めて返す
- 表を読むのは `api.table(名前)`（省いた列は既定値で埋めた行。ctx.table と同じ）か `api.get('$表.行.列')`。再生を始めるのは `api.play({ scene, params })`（ステージを試すボタンなど。ゲームの画面を前に出す。止めるのは `api.stop()`。再生中のシーンの切り替えは `api.on('scene', ({ from, to }) => …)`）
- 再生中のゲームは `api.game`（world・ctx・frame。書いた値はその場で効くが保存しない。`ctx.emit` で出来事を送れる）、`api.pause()`・`api.step(n)`・`api.speed`。保存データは `api.save`（再生中はそのゲーム、止めていれば次の再生で読まれるもの）。部品・表の形は `api.schema('Health' | '$enemies')`
- 一時停止しているかは `api.paused`、画面の重さは `api.perf`（1フレームの処理・描画の ms・描く命令の回数）。エディタのゲームの画面に重ねて描くのは `api.overlay((g, view) => …)`（描き方は舞台の draw と同じ。再生中も編集中も）。`api.on('play')`・`api.on('scene')` は、新しいシーンのシステムの start より前に来る
- 窓は `api.modal(close => 中身)`。ほかの拡張のパネルを前に出して渡すのは `api.show(拡張のid, args)`（受け手は `api.on('show', fn)`）。アセット・プレハブをパネルに落とすときの型は `api.dragTypes`。パネルの中のキーは、本体のシーンの編集（Ctrl+A・Delete・矢印）に渡らない
- ゲーム独自の検証（同じ位置に2つ・組になっていない など）は、パネルの中だけで調べずに `game/index.ts` の `checks: [defineCheck({ name, desc, run(view) })]` に書く（view は table・prefab・prefabs(タグ)・scene。ages check とエディタの ⚠ に出て AI にも届く。編集は止めない）
- 小さな画面でくり返し動かすのは試しの舞台 `api.stage(el, opts)`。プレハブだけなら `{ spawn: [{ prefab }], seconds, zoom, keys, onCycle }`（本体の「試し」の窓 `src/editor/builtin/tryout.ts`）、シーンなら `{ scene, params, values: { 物のID: { 部品: { フィールド: 値 } } }, seconds, loop: false }`（values は保存しない上書き）。値が変わったときは `onChange: 'restart'`（既定）・`'keepTime'`（作り直して同じ時刻へ）・`'none'`。見え方は `view: { free: true, zoom: 0.7 }`（画面の外も見せ、画面の枠を点線で。ホイール・右ドラッグ）と `colliders: true`
  - 返す舞台で、時間は `playing`・`step(n)`・`await seek(秒)`・`frame`・`time`・`onFrame(fn)`、中は `game`（world・ctx）・`send(出来事, data)`（on が受ける）。描き込みは `draw((g, view) => g.circle/rect/line/polyline/text(ワールドの px…, { color, fill, width, dash, alpha, px }))`、取っ手は `onPointer(ev => …)`（ev.x・ev.y はワールド。down で true を返すとその押しを使う）と `toWorld`・`toScreen`
- 画面なしで動かして中を読むのは `await api.run({ scene, params, values か spawn, frames, keys, onFrame(game), until(game), signal })`。少しずつ回すので画面は固まらない。結果は frames・stopped・events・warnings・error・game で、ages run と同じ結果（速さも同じくらい。240秒×120fps で数秒〜十秒）
- モジュールの一番外では `document` などのブラウザの物を使わない（地図を作るときに Node で読むため）
- 作ったら `ages check` で、宣言の誤り（ない住所・ない型や部品・書き忘れ・登録し忘れ）を確かめる

## export: 書き出し（Web・デスクトップの exe）
- `ages export <dir>` で `dist/web` に、エディタを含まないゲームだけの一式を作る（`ages check` にエラーがあれば書き出さない）。動くかは `--check`（headless の Chrome で約3秒進め、エラーがないかを見る）。人が手元で試すなら `--serve`、エディタなら「書き出し」パネルの「書き出したものを開く」
- 人に見てもらう確認用のページ（再生と見本帳）は `guide:review`
- 書き出しの中の `.ages-export` に、ファイルごとの一覧（場所・大きさ・sha1）が入る。2回目からは前の書き出しとの違い（`+` 増えた・`~` 変わった・`-` 消えた）が出るので、変わったファイルだけを送れる（送った先の照らし合わせにも同じ一覧）。ほかの書き出しと比べるなら `--diff <その .ages-export>`
- Web はフォルダごと置けば遊べる。itch.io なら `dist/web` の中身を zip にして、HTML のゲームとして上げる
- 書き出すのは、ゲームのコード（`game` の入り口から import でたどれるもの）・シーン・プレハブ・表・切り方・設定・アセットすべて。ゲームのコードは `ages` とプロジェクトの中のファイルだけを import する（npm の部品・プロジェクトの外のファイルは入らない。⚠ が出る）。読み込むファイルの名前を式で組み立てない（たどれない）
- デスクトップ（Steam 向け）は `--desktop --id com.名前.ゲーム`。`dist/desktop/src-tauri`（Tauri v2）は初めの1回だけ作り、上書きしない。ID はセーブの置き場所を決めるので、出した後は変えない。初めから全画面なら `--fullscreen`
- exe を作るのは人のパソコン（Windows に Rust・C++ のビルドの道具・Tauri の道具。手順は `dist/desktop/README.md`）。`cargo tauri build` の前に、毎回 `ages export --desktop` で Web を新しくする
- 遊ぶ側の全画面は F11 か Alt+Enter（Esc はゲームに渡る）。セーブは遊ぶ側のブラウザ・アプリの中に残る
- `dist/` は Git に入れない（`.gitignore` に足す）・アセットとしても読まない。`dist/` の下にアセットを置かない

## talk: エディタの人とのやり取り（作業を見せる・質問・付箋）
- 人は AI と同時にエディタで作業している。何をしているかを見せると、人は AI の作業中の所を避け、AI の変更を作業ごとに確かめられる（エディタの「AI」パネルと上のバー。変えた所には印）
- 作業の始めに `ages talk <dir> --task "何をするか" --steps "見る|変える|試す" --touch @enemy,$enemies`（touch は触る予定の住所。物・プレハブ・表くらいの大きさで）。区切りで `--step 2`、触る所が増えたら `--touch 住所`、終わりに `--done "結果の一言"`。新しい `--task` は前の作業を終える
- 作業中の `ages set` / `ages patch` などの変更には、その作業の ID が付く（操作ログ。人は作業ごとに ✓ 見た・↶ 戻す ができる）。コードのファイルの変更も、作業中なら差分がその作業に並ぶ
- 人が決めること（手触り・面白さ・個性・好み）は `--ask "質問" --choices "A|B" --about 住所`。答えを待たずに、決めなくてよい所から続ける。答えは次の ages の出力の先頭に 📌 で知らされる
- 出力の先頭に `📌 エディタの人から: 付箋 1` などが出たら、`ages talk <dir>`（引数なし）で読む。付箋は人が物・欄・行に貼った頼み（`[住所]` 付き）。片付けたら `--reply 付箋ID "何をしたか"` で済にする（返事は人のエディタに出る）
- 人がエディタで入力中の欄（と、それを含む物）は変えられない（「人がエディタで … を入力中です」）。少し待つか、ほかの所を先に
- やり取りは `.ages/talk.jsonl`（Git で共有。追記だけ）。直接書かない

## perf: 速さを確かめる（重い所を探す）
- 使うのは、重い・カクつくと言われたときと、物をたくさん出す仕組みを作ったときだけ: `ages run <dir> --frames 600 --keys … --perf`（MCP は ages_run の `perf: true`）。ふだんの確かめには付けない
- `perf:` の行は 1フレームの時間（平均・真ん中・最大とそのフレーム）と、物がいちばん多かったフレーム。`重い順:` は システムごとの1フレームあたりの時間と割合（（ ）で囲んだ名前は標準の処理）
- 同じ入力なら同じ処理なので、3回測ってフレームごとに短い方を出している（たまたまの遅れは入らない。メモリの片付けの一瞬の止まりも入らない）
- 1フレームの時間（60fps なら 17ms）を超えたフレームがあると ⚠（どのフレームで・どのシステムが）。Node で測った目安（ブラウザでも近い）。描く時間は入っていないので、半分を超えていたら重いと考える
- `描画` の行は、物がいちばん多いフレームを描いたときの量: 命令の回数・2D の四角・3D の三角形（影の地図に描く分も入る）と粒（Chrome が要る。`--perf logic` で省ける）。描く時間そのものは測れない（画面なしの Chrome は GPU を使わない）ので、量で見る。目安は 命令 500回・三角形 50万・四角 2万まで（超えると ⚠）
- 直し方: 重いシステムの中の総当たり（`for` の中でもう一度 `query`）を `ctx.hit`・グループ・タグで絞る／毎フレームでなくてよい処理は数フレームに1回／画面の外に出た物・役目の終わった物を消す（Lifetime）／命令が多いなら、画像を1枚のシートにまとめる・3D は同じ形と材質にそろえる
- 直したら同じ入力でもう一度測って比べる。`hash=` が同じなら、ゲームの結果は変わっていない（速くしただけ）

## review: 人に見せる（確認用のページ）
- **動き・演出・音があるもの（動く UI も）を人に見せるときは、確認用のページだけを渡す。** GIF・連番画像・並べた1枚・動画は作らない（人は動くもののほうがずっと分かりやすく、音も確かめられる）。止まった絵（配置・1つの画面）だけは、画像1枚でよい
- 作り方: `ages export <dir> --review --replay "0-120:@fire;…" --frames 600`。`--replay` は ages run の `--keys` と同じ書き方（`--scene`・`--seed`・`--params`・`--save`・`--date`・`--input` も同じ）。先に `ages run` で同じ入力を流して、見せたい場面が出ることを確かめてから書き出す
- 開くと、その入力で再生して止める（最初から・一時停止・コマ送り・速さ・フレームの番号・「自分で」で途中から操作）。「見本帳」はプレハブ（演出・音・物）と音のファイルを並べ、押すと空の場面に1つだけ出す（くり返す）。スマホのブラウザでも見られる
- 渡し方: クラウドで作業しているなら、`dist/web` をページとして上げて、会話にリンクを置く。使用者の PC で作業しているなら、`ages export <dir> --review … --serve` で開いて、ブラウザで開く URL を伝える（index.html を直に開いても動かない）。人に見せるとき、何を見てほしいか（どのフレームの・何を）を一言添える
- 遊ぶ版・ストアに出す版は `--review` なしで書き出す（確認用の画面は入らない）
- **演出はプレハブにする**（パーティクル・効果音・動くスプライト）。コードからは出すだけ（`ctx.spawn('explosion', { Transform: … })`）。敵ごとの色・ダメージで粒の数のように変えたいときは、1つのプレハブを土台にして出すときに上書きする（種類ごとにプレハブを増やさない）。プレハブにすると、人がエディタで数値を触れて、見本帳に並び、ゲームの仕組みを組み直しても壊れにくい
- 物でない演出（画面の揺れ・ヒットストップ・画面のフラッシュ）は見本帳に出ないので、再生で場面ごと見せる

## packages: 追加パッケージ（3D など、入れたプロジェクトでだけ使える機能）
- 本体に入っているが、プロジェクトが選んだときだけ読み込む機能のまとまり。入れていないプロジェクトでは、その部品・手順・地図の行は出ない（毎回読む量を増やさないため）
- 入れ方: `ages.project.json` に `"packages": ["3d"]` を足す（このファイルは直接直してよい設定）。入れると、地図に `## package 3d` とその機能の目次が出て、`guide:項目` で手順を引ける。ゲームのコードからは `import { … } from 'ages/3d'`
- いまあるもの: `3d`（3D。位置・回転、モデル、光と影、カメラ、当たり判定、エディタの3Dの視点。作っている途中で、部品はこれから足す）
- 2D か 3D かは、最初のエディタ計画（EDITOR-PLAN.md）で使用者に聞く。途中から足してもよい（外すのは、その部品を使っている物がなくなってから）
