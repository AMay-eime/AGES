# AGES でAIが作業するときの手順

短く保つこと。このファイル自体がトークンを使う。

`ages` は `node bin/ages.js`（`npm link` で `ages` コマンドになる）。MCPが使えるなら、同じ機能が道具 `ages_map` `ages_get` `ages_set` `ages_patch` `ages_run` `ages_log` `ages_check` `ages_init` `ages_schema` として渡されている。

## ゲームの企画を受けたら（最初の最初に必ず）

**いきなりゲームのコードを書かない。先に「このゲームを作るには、どんなエディタが必要か」を使用者と決める。**

1. プロジェクトがなければ `ages init <dir> --name <名前>` で作る。`EDITOR-PLAN.md`（エディタ計画書）ができる
2. 使用者に「一緒に決めるか、AIにおまかせか」を聞く（おまかせを自分から選ばない）
3. 一緒に決める: `EDITOR-PLAN.md` の質問を使用者に確認しながら埋める（何度も調整する値／表や行列で扱うもの／必要な独自ウインドウ／試し方／最初からロックする値／作業する人／AGESに足りない機能）。使用者が「合意」にチェックするまで、ゲームのコードは書かない
   おまかせ: AIが全項目を埋め、決めたことに「AI案」と書く。「使用者がAIにおまかせした」にチェックし、使用者の言葉を書き残す。計画の要点を使用者に短く伝えてから作り始める
4. 合意したら、エディタ側（コンポーネントの宣言・独自ウインドウ）を先に作り、その上でゲームを作る
5. 面白さの核・手触り・個性は使用者が決める。AIが出すものは「案」と明記する

AGESに足りない機能（画像・音・物理など。docs/PLAN.md の段階2）が必要なら、計画の段階で使用者に伝える。作り始めてから気づかない。

## 作業を始めるとき（毎回）

1. `ages map <dir>` — 全体の地図。コンポーネント・システム・プレハブ・シーン・🔒★の印がすべて載る。ファイルを開いて回る前にこれを読む。エディタ計画が未合意なら先頭に警告が出る
2. `ages log <dir>` — 前回から人が何を変えたかの要約。人の調整の意図をくみ取る
3. 計画にない作業を頼まれたら、`EDITOR-PLAN.md` に追記して使用者に確認する

## 値を変える

- シーン・プレハブの値は `ages set` / `ages patch` で変える。JSONを直接書き換えない（検証とログが通らない）
- 間違えた編集は `ages undo <dir>` で戻す（逆の操作を考えなくてよい。`ages redo` でやり直す）。その後で人が同じ所を変えていれば止まる
- 行列（matrix）はセル単位で変える: `ages set <dir> 住所[行,列] 値`、まとめてなら patch の `setCells`。行列全体を送り直さない
- リストの中は `住所[番号]`、構造体・どれか1つの中は `住所.名前` で直接変える。足す・消す・動かすは patch の `insert` / `removeItem` / `moveItem`
- 同じ形の行がたくさん並ぶデータ（武器・敵・カードなど）は表にする（`defineTable` と `data/<表>.table.json`）。住所は `$表.行.列`、読むのは `ages table <dir> <表>`、行は `addRow` / `removeRow` / `moveRow` / `renameRow`。ゲームのコードは `ctx.table(形).get(ID)`
- 表を CSV にしたいとき・CSV から移すときは `ages table --export` / `--import`
- `🔒` ロックされた値は変更できない（`--force` でも不可）。変えるべき理由があれば、人に提案する（人はロックマネージャーで変える）
- ロックを付けたほうがよい値に気づいたら、人に提案する（ロックをかけるのは人がエディタかロックマネージャーで、外すのはロックマネージャーでだけ。AI からはどちらもできない）。`🔒ファイル` の付いたアセットは、差し替え・移動・削除ができない
- `.ages/locks.json`・`.ages/locks.seal` は決して触らない。書き換えると封印と合わなくなり、人が確認するまでAIの編集はすべて止まる
- `★` 人が調整した値は、変える前に人へ確認し、了承を得てから `--force`
- エラーには範囲や候補（もしかして）が書いてある。読み込み直さず、それに従って直す

## 確かめる

- `ages run <dir> --frames 1800 --keys "0-1800:@fire;0-300:@move_x=-1" --watch player.Health.hp --until gameOver`
- `--keys` は `開始-終了:入力+入力`。`@操作`（表 $actions の名前）、`@操作=-1`（− の向き）、`@操作=0.5`（アナログ）、`KeyZ` などのボタン、`Pad.LX=0.7`（軸）、`ptr=240,100`（マウスの位置）、`wheel=1`
- 人の操作を再現: `--input recordings/<名前>.input.json`
- 変更後は `--twice` で再現性（毎回同じ結果か）を確認する
- 画面の確認が必要なときだけエディタやスクリーンショットを使う（画像は高い）

## ゲームコードの決まり（game/*.ts）

- 乱数は `ctx.rng`、時間は `ctx.frame` / `ctx.time`。`Math.random` や `Date` は使わない
- システムには `desc` と `reads` / `writes` を書く（地図と依存関係の検索に使われる）
- フィールドには `desc` と、意味のある `min` / `max` を必ず付ける（インスペクタと検証に使われる）
- 実行中だけ変わる値（クールダウンなど）は desc に「自動で変化」と書く

## 標準の部品と画像

- Transform / Sprite / Animator / Shape / Text は標準で用意されている。game/ で作り直さない。中身は `ages schema <dir> Sprite`
- 画像はプロジェクト内のパスで指定する（`Sprite.image: "assets/x.png"`）。コマは `Sprite.frame`（番号か名前）、動きは `Animator.clip`
- 切り方は `ages sheet <dir> <画像>` で見る。画像を開いて確かめない（何コマあるかは `ages map` にも出る）
- 切るのは `ages slice <dir> <画像> --grid 32x32 | --count 4x6 | --auto`（`--dry` で保存せずに確かめる）。1コマ・1動きの変更は patch の `setFrame` / `setClip`。`.sheet.json` を直接書き換えない
- コマを指定するときは名前を使う（切り直してもずれない）。切り方の🔒・★はシーンの値と同じ扱い
- カメラは標準の Camera（`ages schema <dir> Camera`）。追いかけ・範囲の制限・揺れは自分で書かない。揺らすのは `ctx.shake(0〜1)`
- 画面の大きさへの合わせ方は `ages.project.json` の `view.fit`。ゲームのロジックは `ctx.view`（設計の大きさ）だけを使う
- 音は Sound の付いたプレハブ（例 `@se_shot`）を作り、`ctx.sound.play('se_shot')` で鳴らす。音量などの調整値はプレハブに置き、コードに書かない。BGM・環境音は物に Sound（playOnStart）を付ける
- 音量の区分はゲームに合わせて AudioBus のプレハブで作る（例 `@bgm` exclusive、`@se`）。どんな区分にするかは EDITOR-PLAN.md で使用者と決める
- 鳴ったかどうかは `ages run` の `sounds:` と ⚠ で確かめる（音を聞かなくてよい）
- シーンの切り替えは `ctx.scene.goto('名前', { fade, params })`、次のシーンで `ctx.scene.params`。切り替えても残す物には tag `keep`。そのシーンでだけ動くシステムには `scenes: ['名前']`。確かめるのは `ages run --until scene:名前`
- シーンを作る・消す・名前を変える・開始にするのは `patch` の `addScene` / `removeScene` / `renameScene` / `setScene`（ファイルを直接作らない。名前を変えると参照とロックも直る）
- アセットの一覧と使っている所は `ages assets <dir>`（`--unused` で使っていないもの、`--refs 場所` で使っている所）。画像を開いて確かめない
- アセットの場所を変える・消すときは、ファイルを直接動かさず `patch` の `moveAsset` / `removeAsset`（使っている値と切り方も直る。使われているものは消せない）。新しいファイルは assets/ の下に置くだけでよい
- 入力は操作の名前で読む（`ctx.input.isDown('fire')` / `pressed` / `value('move_x')`）。キーの名前をコードに書かない。操作と既定の割り当ては標準の表 `$actions`（`ages table <dir> actions`）に行を足す
- キーコンフィグの画面はゲームのスクリプトで作る: `ctx.input.bind(操作, { keys: [...] })` / `resetBindings()` / `lastPressed()` / `usedBy(ボタン)` / `label(ボタン)`。セーブには `exportBindings()` を入れ、読み込みで `importBindings()`
- マウス・タッチの位置は `ctx.input.pointer`（画面の座標）か `ctx.pointerWorld()`（ワールドの座標）
- 値を時間で変える演出（点滅・はねる・薄くして消す）は `ctx.tween(物, { 'Sprite.alpha': 0 }, '名前')`。自分でフレームを数えない。手触り（秒数・ease・くり返し）は標準の表 `$tweens` に行を足して名前で使い、コードに数字を書かない。`'+10'` で今の値からの相対、`from` で始めの値、`destroy` / `emit` で終わったときの処理。止めるのは `ctx.stopTween`
- 見た目の効果（光らせる・縁取り・溶かす・画面の端を暗くする）は、物に Effect（その物）か PostEffect（画面全体）を付けて `shader` を選ぶ。まず標準の `std:flash` `std:outline` `std:dissolve` `std:desaturate` `std:vignette` `std:crt` で足りるか考える。値は `params.名前`（patch の住所も `…Effect.params.amount`）。動かすのは `ctx.tween(id, { 'Effect.params.amount': 0 }, '名前')`
- 新しいシェーダーは assets/ の下に `.frag` を置く。書くのは `vec4 effect(vec4 c, vec2 uv)` と、`uniform float x; // 0..1 =0 説明` の形の宣言だけ（書き方と手本は `ages schema <dir> std:flash`）。エディタを開いていればコンパイルの結果が `ages check` に出るので、画面を見ずに直せる
- 粒（火花・煙）は標準の Particles を物（プレハブ）に付ける（`ages schema <dir> Particles`）。現れたときに出すのは `burst`、出し続けるのは `rate`。後から出すのは `ctx.particles.burst(id)`。粒の動きは描く側で動かし、ゲームの結果には入らない。出したかどうかは `ages run` の `particles:` で確かめる

## エディタウインドウ

プロジェクト独自の調整画面は `editor/<名前>.window.ts` に `defineWindow` で書き、`ages.project.json` の `editorWindows` に追加する。例: `examples/shooter/editor/wave-tuner.window.ts`

- **作る前に地図の `## editor windows` を見る。** 近いものがあれば、新しく作らずにそれを直す（ウインドウが増えすぎないように）
- `desc`（何のためか、1行）と `edits`（変える値の住所。`main#spawner.Spawner.*` のようにまとめても書ける）を必ず書く。地図にはこの宣言が1行で出るので、コードを読まなくても分かる
- ウインドウからは `edits` に書いた値しか変えられない。🔒ロックされた値はウインドウからは変えられない（人がロックマネージャーで変える）。ロックの操作をウインドウに作らない（作っても、サーバーが受け付けない）
- 値を変えるのは `api.patch` だけ（エディタのサーバーを直接呼ばない）。モジュールの一番外では `document` などのブラウザの物を使わない（地図を作るときに Node で読むため）
- 作ったら `ages check` で、宣言の誤り（ない住所・書き忘れ・登録し忘れ）を確かめる

## 役割分担

面白さの核・手触り・個性を決めるのは人。AIはそれ以外を速く、正確に、少ないトークンで支える。
