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

## prefab: プレハブと派生
- プレハブ（`@名前`）は、コードから `ctx.spawn('名前')` で出す物のひな形。作る・消す・名前を変えるのは patch の `addPrefab` / `removePrefab` / `renamePrefab` / `setPrefab`（ファイルを直接作らない。名前を変えると prefab 型の値・派生の元・🔒★も直る。コードの中は直らないので ⚠ に従って直す）
- 似た物（速い敵・硬い敵など）は、写すより派生にする: `{"op":"addPrefab","name":"enemy_fast","base":"enemy","components":{"Velocity":{"vy":6}}}`。元の値を受け継ぎ、書いた値だけが変わる。元を直すと、派生の変えていない値も一緒に変わる
- 派生の値もふつうの住所で読み書きする（`@enemy_fast.Velocity.vy`）。変えた値は フィールドごと（リスト・構造体は丸ごと）。元と同じ値にすると「受け継ぐ」に戻る
- 元の値に戻すのは `{"op":"revert","path":"@enemy_fast.Velocity.vy"}`（部品ごとなら `@enemy_fast.Velocity`。外した部品も戻る）。派生でない物の revert は既定値に戻す
- 元から部品を外すのは `removeComponent`、足すのは `addComponent`。切り離す（ふつうのプレハブにする）のは `setPrefab` の `base: null`（値は変わらない）
- 地図の `@x ← @元` が派生、`変:` が元から変えた所。受け継いだ値にロックが付いていると、元を変えてその値が変わる編集は止まる
- 数値だけが違う行がたくさん並ぶなら、派生より表（table）が向く

## sprite: 画像・コマ・動き
部品: Sprite Animator
- 画像はプロジェクト内のパスで指定する（`Sprite.image: "assets/x.png"`）。コマは `Sprite.frame`（番号か名前）、動きは `Animator.clip`（標準のシステム std.animator が進める）
- 切り方は `ages sheet <dir> <画像>` で見る。画像を開いて確かめない（何コマあるかは地図にも出る）
- 切るのは `ages slice <dir> <画像> --grid 32x32 | --count 4x6 | --auto`（`--dry` で保存せずに確かめる。前と同じ場所のコマは名前を引き継ぐ）
- 1コマ・1動きの変更は patch の `setFrame` / `setClip`（例 `{"op":"setFrame","image":"assets/x.png","frame":"x_3","name":"hero_idle","pivot":[0.5,1]}`）。`.sheet.json` を直接書き換えない
- コマを指定するときは名前を使う（切り直してもずれない）。切り方の🔒・★はシーンの値と同じ扱い

## camera: カメラと画面の大きさ
部品: Camera
- カメラは標準の Camera（`ages schema <dir> Camera`）。追いかけ・範囲の制限・揺れは自分で書かない（標準のシステム std.camera が動かす）。揺らすのは `ctx.shake(0〜1)`
- 画面の大きさへの合わせ方は `ages.project.json` の `view.fit`。ゲームのロジックは `ctx.view`（設計の大きさ）だけを使う

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
- `ages run --keys` の書き方: `開始-終了:入力+入力`。`@操作`、`@操作=-1`（− の向き）、`@操作=0.5`（アナログ）、`KeyZ` などのボタン、`Pad.LX=0.7`（軸）、`ptr=240,100`（マウスの位置）、`wheel=1`、`click=x,y` / `click=ボタンのID`（1フレームだけ押す）

## scene: シーン
- 切り替えは `ctx.scene.goto('名前', { fade, params })`、次のシーンで `ctx.scene.params`。切り替えても残す物には tag `keep`
- そのシーンでだけ動くシステムには `scenes: ['名前']`。確かめるのは `ages run --until scene:名前`
- シーンを作る・消す・名前を変える・開始にするのは patch の `addScene` / `removeScene` / `renameScene` / `setScene`（ファイルを直接作らない。名前を変えると参照とロックも直る）

## assets: アセット（画像・音・フォント）
- 一覧と使っている所は `ages assets <dir>`（`--unused` で使っていないもの、`--refs 場所` で使っている所）。画像を開いて確かめない
- 場所を変える・消すときは、ファイルを直接動かさず patch の `moveAsset` / `removeAsset`（使っている値と切り方も直る。使われているものは消せない）
- 新しいファイルは assets/ の下に置くだけでよい。`🔒ファイル` の付いたアセットは、差し替え・移動・削除ができない

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

## save: 保存
- `ctx.save.get/set`（最高得点・進み具合）。物ごとまとめて残すなら `saveWorld(key, { tags: ['save'] })` / `loadWorld(key)`（型が変わっても戻せる）
- キーの割り当て・音量・言語は自動で保存されるので書かない
- 保存がある状態は `saves/x.save.json` を置いて `ages run --save saves/x.save.json` で確かめる（`--save-out` で終わりの状態を書き出す）

## particles: 粒（火花・煙）
部品: Particles
- 標準の Particles を物（プレハブ）に付ける（`ages schema <dir> Particles`）。現れたときに出すのは `burst`、出し続けるのは `rate`。後から出すのは `ctx.particles.burst(id)`
- 粒の動きは描く側で動かし、ゲームの結果には入らない。出したかどうかは `ages run` の `particles:` で確かめる

## window: プロジェクト独自のエディタ拡張（パネル・インスペクタの欄と部品の見せ方）
- **作る前に地図の `## editor extensions` を見る。** 近いものがあれば、新しく作らずにそれを直す（拡張が増えすぎないように）
- `editor/<名前>.ext.ts` に `defineExtension` で書き、`ages.project.json` の `editorWindows` に追加する。窓口は要る分だけ:
  - `panel: { title, area?, mount(el, api) }` 調整用の画面（例 `examples/shooter/editor/wave-tuner.window.ts`。パネルだけなら `defineWindow` でもよい）
  - `fields: [{ match, mount(el, field, api) }]` インスペクタの欄の見せ方。match は 型（`'color'`）・部品.フィールド（`'Health.hp'`）・住所（`'main#player.Health.hp'`）。`field.value` を見せ、`field.set(値)` で変える。`field.standard()` で標準の欄も並べられる（例 `examples/shooter/editor/hp-hearts.ext.ts`）
  - `components: [{ component, hide?, mount(el, comp, api) }]` 部品の欄の上に中身を足す。`hide: 'all'` か名前の並びで標準の欄を隠す。`comp.set(フィールド, 値)`（例 AGES 本体の `src/editor/builtin/ui-dock.ts`）
- `desc`（何のためか、1行）を必ず書く。パネルがあるなら `title` と `edits`（パネルが変える値の住所。`main#spawner.Spawner.*` のようにまとめても書ける）も。地図にはこの宣言が1行で出る
- 拡張から変えられるのは、`edits` に書いた値と、見せている欄・部品の値だけ。🔒ロックされた値は拡張からは変えられない。ロックの操作を拡張に作らない（作っても、サーバーが受け付けない）
- 値を変えるのは `api.patch`・`field.set`・`comp.set` だけ（エディタのサーバーを直接呼ばない）。読むのは `api.get`（派生は元と重ねた値）、知らせるのは `api.notify(文, 'warn')`、画像の切り方は `api.sheet(画像)`
- モジュールの一番外では `document` などのブラウザの物を使わない（地図を作るときに Node で読むため）
- 作ったら `ages check` で、宣言の誤り（ない住所・ない型や部品・書き忘れ・登録し忘れ）を確かめる
