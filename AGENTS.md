# AGES でAIが作業するときの手順

短く保つこと。このファイルは毎回読まれる。機能ごとの詳しい手順は `ages schema <dir> guide:<項目>` で、その機能を使うときだけ引く（中身は docs/GUIDE.md）。

`ages` は `node bin/ages.js`（`npm link` で `ages` コマンドになる）。MCPが使えるなら、同じ機能が道具 `ages_map` `ages_patch` `ages_run` などとして渡されている。

## ゲームの企画を受けたら（最初の最初に必ず）

**いきなりゲームのコードを書かない。先に「このゲームを作るには、どんなエディタが必要か」を使用者と決める。**

1. プロジェクトがなければ `ages init <dir> --name <名前>` で作る。`EDITOR-PLAN.md`（エディタ計画書）ができる
2. 使用者に「一緒に決めるか、AIにおまかせか」を聞く（おまかせを自分から選ばない）
3. 一緒に決める: `EDITOR-PLAN.md` の質問を使用者に確認しながら埋める。使用者が「合意」にチェックするまで、ゲームのコードは書かない
   おまかせ: AIが全項目を埋め、決めたことに「AI案」と書く。「使用者がAIにおまかせした」にチェックし、使用者の言葉を書き残す。計画の要点を使用者に短く伝えてから作り始める
4. 合意したら、エディタ側（コンポーネントの宣言・独自ウインドウ）を先に作り、その上でゲームを作る
5. AGESに足りない機能が必要なら、計画の段階で使用者に伝える

## 作業を始めるとき（毎回）

1. `ages map <dir>` — 全体の地図（コンポーネント・システム・表・プレハブ・シーン・🔒★の印）。ファイルを開いて回る前にこれを読む。大きなプロジェクトでは目次になる（`名前/(数)` はまとめ）。中身は `ages find <dir> 語`（名前・説明から探す。例 `移動速度`）か `ages map <dir> 節/まとめ`（例 `prefabs/se`）で引く。コードは、ファイルを開く前に `ages code <dir> 名前`（宣言の場所・使っている所。`--body` で中身。`$表.列`・`部品.欄`・ファイル・日本語の語でも引ける）
2. `ages log <dir>` — 前回から人が何を変えたかの要約。人の調整の意図をくみ取る
3. 計画にない作業を頼まれたら、`EDITOR-PLAN.md` に追記して使用者に確認する
4. `ages talk <dir> --task "何をするか" --steps "a|b" --touch 住所` で人のエディタに作業を見せ、区切りで `--step N`、終わりに `--done "結果"`。出力の先頭に 📌 が出たら `ages talk <dir>` で人の付箋・答えを読む

## 値を変える

- `ages set` / `ages patch` で変える。JSON・アセットのファイルを直接書き換えない・動かさない（検証とログが通らない）。patch の操作の一覧は `ages schema <dir> ops`
- 住所: `シーン#ID.コンポーネント.フィールド`、プレハブは `@名前…`、表は `$表.行.列`。行列はセル `[行,列]`、リストの中は `[番号]`、構造体の中は `.名前`。全体を送り直さない
- 間違えた編集は `ages undo <dir>` で戻す（逆の操作は不要。`ages redo` でやり直す）
- `🔒` ロックされた値は変更できない（`--force` でも不可）。変えるべき理由・ロックを付けたほうがよい値に気づいたら、人に提案する（ロックの操作は人だけ）
- `.ages/locks.json`・`.ages/locks.seal` は決して触らない（書き換えると、人が確認するまでAIの編集がすべて止まる）
- `★` 人が調整した値は、変える前に人へ確認し、了承を得てから `--force`
- エラーには範囲や候補（もしかして）が書いてある。読み込み直さず、それに従って直す

## 確かめる（作業の重さに合わせて最小で）

- 調べるだけ: 確かめない。値・データだけ: `ages check`
- コードの1か所の直し: 型チェックと `ages check`。読んで分からないときだけ直す前と後を1回ずつ動かす
- 部分をつなぐコード（出来事・表の言葉・UI。型チェックで見えない）: さらに `ages run` を短く1回。`--twice` は乱数・時間・持ち越す状態に触れたときだけ
- `ages run <dir> --frames 1800 --keys "0-1800:@fire;0-300:@move_x=-1" --watch player.Health.hp --until gameOver`（keys は guide:input）。人の操作の再現は `--input recordings/<名前>.input.json`、プレハブだけは `--spawn 名前`
- 画面・画像・音を開かずに、要約の行（`sounds:` `hits:` `ui:` `particles:` `save:` など）と ⚠ で確かめる。見た目の確認が要るときだけ `--shot 600`（画像は高いので `--shot-scale 0.5`）

## ゲームコードの決まり（game/*.ts）

- 乱数は `ctx.rng`、時間は `ctx.frame` / `ctx.time`、日時は `ctx.date`。`Math.random` や `Date` は使わない → `date`
- システムには `desc` と `reads` / `writes`、フィールドには `desc` と意味のある `min` / `max` を必ず書く（地図・インスペクタ・検証に使う）。実行中だけ変わる値は desc に「自動で変化」（地図では名前だけになる）
- 手触りの数字（秒数・速さ・音量）はコードに書かず、コンポーネント・プレハブ・表に置く
- 1ファイルは1つのシステム・機能に（目安は数百行。巨大だと読む量が増える）

## 機能の目次（標準で足りるか先に見る。作り直さない。詳しくは guide:項目）

- 表（武器・敵など同じ形の行）: `defineTable`・`ages table`・CSV → `table`
- プレハブ・派生・インスタンス（元を受け継いで一部だけ変える。シーンに置く物も prefab でつながる）: patch の addPrefab（base）・addEntity（prefab）・revert → `prefab`
- 画像・図形（線・枠）・コマ・動き・切り抜き: Sprite・Shape・Animator・Clip・`ages sheet` / `ages slice`。画像を開かない → `sprite`
- カメラ・画面の大きさ: Camera・`ctx.shake`・`view.fit` → `camera`
- 音: Sound のプレハブと `ctx.sound.play`・AudioBus → `sound`
- 入力・キーコンフィグ: 表 `$actions` と `ctx.input.isDown('fire')`。キーの名前をコードに書かない → `input`
- シーン: `ctx.scene.goto`・patch の addScene など → `scene`
- システムどうしの連絡: `ctx.emit` と `on`（出す側に受ける側の呼び出しを書かない） → `event`
- アセットの一覧・移動・削除: `ages assets`・patch の moveAsset / removeAsset → `assets`
- 時間で変える演出: `ctx.tween` と表 `$tweens`。自分でフレームを数えない → `tween`
- 見た目の効果: Effect・PostEffect と `std:flash` などのシェーダー・`.frag` → `shader`
- HUD・メニュー・ボタン・ゲージ: UI をシーンに置く（コードで画面を組み立てない）。配置の直しは patch の `dockUI` / `attachUI`（座標を計算しない）と `ages ui` → `ui`
- 位置の親子（親と一緒に動く）: Transform.parent。子の値は親から見た値、画面の位置は `ctx.worldOf` → `transform`
- 当たり判定: Collider と `ctx.hit`。距離の計算を書かない → `hit`
- 画面の言葉・多言語: 表 `$text` と `ctx.t`・Text.key。言葉をコードに書かない → `text`
- 保存: `ctx.save`・`saveWorld`。キー割り当て・音量・言語は自動 → `save`
- 粒（火花・煙）: Particles → `particles`
- 書き出し（Web・Steam 向けの exe）: `ages export` → `export`
- 独自のエディタ拡張（パネル・欄・部品・表の行の見せ方）: `defineExtension`。作る前に地図の `## editor extensions` を見て、近いものを直す → `window`
- エディタの人とのやり取り（作業を見せる・人に聞く・付箋に返事）: `ages talk` → `talk`
- 速さ（重い所を探す）: `ages run --perf` → `perf`
- 3D など、入れたプロジェクトでだけ使える機能（追加パッケージ）: `ages.project.json` の packages → `packages`

## 役割分担

面白さの核・手触り・個性を決めるのは人（`ages talk --ask` で聞き、答えを待たずに続ける）。AIはそれ以外を速く、正確に、少ないトークンで支える。AIが出すものは「案」と明記する。
