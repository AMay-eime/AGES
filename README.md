# AGES

**All Games should be Edited Speedy** — AIと人が一緒に、速く、少ないトークンでゲームを作るためのゲームエンジン兼エディタ。

- 正本はすべてテキスト（JSON / TypeScript）。人はエディタで、AIはCLIで、同じファイルを編集する
- 画面なしで高速に実行し、結果の要約だけを返す（`ages run`）
- 固定更新・シード付き乱数・入力の記録と再生で、毎回同じ結果になる
- 人とAIのすべての編集を操作ログに残し、人が調整した値はAIが勝手に上書きしない
- ゲームより先にエディタを決める: AIは企画を受けたら、まず必要なエディタを使用者と確認する（`ages init` が計画書のひな形を作る）
- 実行時の外部依存ゼロ。コンパイル待ちなし

- 開発理念: [docs/VISION.md](docs/VISION.md)
- 企画書（現在地・段階的な計画・ベンチマーク）: [docs/PLAN.md](docs/PLAN.md)
- 手順書: [docs/PROCEDURES.md](docs/PROCEDURES.md)
- 決定の記録: [docs/DECISIONS.md](docs/DECISIONS.md)
- 技術設計: [DESIGN.md](DESIGN.md)
- AIがAGESでゲームを作るときの手順: [AGENTS.md](AGENTS.md)（毎回読む目次）・[docs/GUIDE.md](docs/GUIDE.md)（機能ごとの手順。要るときに引く）

## 必要なもの

- Node.js 22.18 以上（TypeScriptをそのまま実行するため）
- 型チェックをする場合のみ: `npm install`（typescript と @types/node）

## 使い方

```sh
# エディタを開く（ブラウザで http://localhost:5170）
node src/editor/server.ts examples/shooter     # 自分のプロジェクトはそのフォルダを指定
npm run editor                                 # サンプルを開く

# テストと型チェック
npm test
npm run check                                  # 事前に npm install が必要

# AI向けCLI
node bin/ages.js init ../my-game --name my-game  # 新しいプロジェクト（エディタ計画書つき）
node bin/ages.js map examples/shooter            # プロジェクトの地図
node bin/ages.js schema examples/shooter guide   # 機能ごとの手順の目次（guide:ui のように引く。ops で patch の操作の一覧）
node bin/ages.js get examples/shooter main#player # 値を見る
node bin/ages.js set examples/shooter main#player.Player.speed 5
node bin/ages.js table examples/shooter enemies  # 表を見る（$enemies.basic.hp のように住所で読み書き）
node bin/ages.js assets examples/shooter          # アセットの一覧（使っている所の数・未使用）
node bin/ages.js sheet examples/shooter assets/kenney-pixel-shmup/ships.png  # 画像の切り方
node bin/ages.js run examples/shooter --frames 600 --watch main#player.Health.hp
node bin/ages.js log examples/shooter            # 前回からの編集の要約
node bin/ages.js undo examples/shooter           # 自分（AI）の直前の編集を元に戻す
node bin/ages.js version examples/shooter        # AGES の版（記録が古ければ直し方。--record で今の版を残す）
```

## MCP（AIのアプリから直接使う）

`ages init` で作ったプロジェクトには `.mcp.json` が入っていて、Claude Code などで開けば自動でつながります。手動で足す場合:

```sh
claude mcp add ages -- node /path/to/AGES/src/mcp/server.ts --project /path/to/my-game
```

使用者のPC上で動く小さなプログラムで、ネット上のサーバーは要りません。

## GitHub と連携する（使う人の選択）

本体とプロジェクトを並べて置く今の形のままでも使えます。クラウドの会話（スマホ・Web）からも同じプロジェクトを触りたいときは、**版だけ同梱**の形にします。

```sh
node /path/to/AGES/bin/ages.js pin my-game     # 既存のプロジェクトを変える（新しく作るなら ages init my-game --pin）
cd my-game
node ages.mjs check .                          # 初回に、決めた版の AGES 本体を .ages/engine に取ってくる（git が要る）
node ages.mjs editor                           # エディタ
node ages.mjs upgrade                          # 本体を新しい版に上げる（起動用と AGENTS.md も合わせる。直しが要れば手順が出る）
```

リポジトリに入るのは起動用の `ages.mjs` と、使う本体の版（`ages.project.json` の `engineSource`）だけ。本体は git の対象外の `.ages/engine` に置くので、AI が本体を書き換えても push されず、次に動かす前に元に戻ります。プロジェクトの `AGENTS.md` は本体の手順の写しで、上げるときに新しい版のものに合わせます（手で直していたら、そのまま残して知らせます）。

## エディタでできること

- 階層（UI の親子と位置の親子（Transform.parent）は木で畳める。運んで親を変える。連番の名前は1行にまとめる）・プロジェクト（ファイル一覧）・アセット・インスペクタ・ゲーム・テキスト・操作ログ・Git
- アプリとしてインストール（Edge・Chrome のアドレスバーの右のアイコンか、メニューの「アプリ」→「このサイトをアプリとしてインストール」）。ブラウザのバーのない窓で開く。ゲームの画面の ⛶ でゲームだけを全画面に（Esc はゲームに渡り、抜けるのは Esc の長押し）
- アセット: フォルダの木と一覧（画像・音・フォントの見本）、取り込み（ドロップ）、名前の変更・移動・削除。場所を変えると使っている値も直り、使われているものは消せない。ゲームの画面へドラッグすると置ける
- インスペクタはコンポーネントの宣言から自動生成。各値に 🔒 ロック（AIは変更不可）を付けられる。ロック済みの値の表示・非表示は設定で選べる
- ロックマネージャー（別のタブ）: ロックを外す・ロックされた値を変えるのはここからだけ（エディタからは人の手でも変えられない）。かけるのはエディタの 🔓 からもすぐできる。画像・音のファイルそのものもロックでき、書き換えられたら手元の控えから戻す
- 2次元行列のパラメータは専用の行列エディタで編集（表計算ソフトからの貼り付け、別ウインドウ表示に対応）
- リスト・構造体・どれか1つ（命令の列など）は、インスペクタの中でそのまま編集（足す・消す・並べ替え）
- 表（武器・敵・カードなど同じ形の行が並ぶデータ）は表のエディタで。セルの直接編集、表計算ソフトからの貼り付け、CSV の書き出し・読み込み、セル・行ごとのロック
- 画像の切り方（スプライトエディタ）: 格子・数・自動で切る、矩形の編集、基準点、動き
- 標準の部品: 画像・アニメーション・図形・文字・カメラ（追いかけ・揺れ・複数）・音（区分・BGM の重ね）・パーティクル
- UI: 画面に固定する物（画面や親のどこに合わせるか・並べる・ボタン・ゲージとスライダー・ダイアログ・折り返す文字・9つに切って伸ばす画像）。シーンに置いてエディタで配置を直せる。端に付ける・隣に接して置く操作（dockUI・attachUI）と、配置を文字で見る `ages ui`（重なり・はみ出しを知らせる）。ボタンは `ctx.ui.clicked('ID')`、AI は `ages run --keys "300:click=retry"` で押して確かめる
- 多言語: 言葉は表 `$text`（列が言語）。`ctx.t('名前', { 値 })` と Text.key、言語の切り替えは設定として自動で保存。名前の間違い・未訳を検証と地図で知らせ、`ages run --lang` で確かめる
- セーブ: `ctx.save`（ブラウザでは localStorage、画面なしではメモリ）。物をまとめて保存して今の型に合わせて戻す、設定（キーの割り当て・音量）の自動保存、`ages run --save` で保存データの状態から確かめる、エディタの 💾 で見る・消す・書き出す
- シーンの編集: いくつも選ぶ（Shift・Ctrl+クリック・四角で囲む）、まとめて動かす、格子への吸着、複製（Ctrl+D）・削除・矢印でずらす、右クリックで複製・削除・プレハブにする
- プレハブの派生（元を受け継いで一部だけ変える）と、選んだプレハブだけをくり返し動かす「試し」の窓（AI は `ages run --spawn`）
- 当たり判定: 円・矩形（回転・倍率込み）とグループ。重なっている相手・点・円・矩形・線で調べる。当たった回数が `ages run` に出る。エディタで形を重ねて見られる（物理演算は本体に入れない）
- シェーダー: 物ごとの効果（Effect）と画面全体の後処理（PostEffect）。書くのは関数1つと値の宣言だけで、値はインスペクタの欄になり、トゥイーンで動かせる。標準で光らせる・縁取り・溶かす・色を抜く・端を暗く・ブラウン管ふう。コンパイルのエラーは `ages check` にも出る
- 演出: トゥイーン（値を時間で変える。手触りは表 $tweens で決める。フレームで数えるので毎回同じ結果）とパーティクル（粒は描く側で動かす。編集中は選んだ物で試せる）
- シーン: ゲームのコードから切り替え（フェード・次のシーンへ渡す値・残す物・シーンごとのシステム）、画像・音の事前読み込み。階層の ⚙ でシーンを作る・複製・名前・開始
- 入力: キーボード・マウス・タッチ・ゲームパッドを「操作の名前」で読む（割り当ては表 `$actions`。⌨ で押して決める）。キーコンフィグはゲームのスクリプトから割り当てを変えて作れる
- 元に戻す・やり直し（Ctrl+Z / Ctrl+Shift+Z）。すべての編集が対象で、その後で別の人が同じ所を変えていれば止まる。操作ログから AI の編集を選んで戻すこともできる
- 再生・一時停止・1フレーム送り。実行中に変えた値は、停止時に保存するか選べる
- 「記録して再生」で入力（キー・パッドの軸・マウスの位置も）を recordings/ に保存。AIは `ages run --input` で同じ操作を再現できる
- ゲーム画面でクリックして選択（重なっていれば同じ場所をもう一度クリックで奥へ）、ドラッグで移動。カメラの視点と自由な視点、画面の形の切り替え
- タブはドラッグで別の場所へ移動でき、境界線で大きさを変えられる（配置は .ages/layout.json に保存）
- プロジェクト独自のエディタ拡張（`editor/*.ext.ts`。パネル・インスペクタの欄と部品の見せ方）を追加できる。本体の機能も同じ API で作っている
- 外部（別のエディタやAI）でファイルが書き換えられると即座に反映。ロックされた値は自動で元に戻る
- ロックの記録そのものが書き換えられると「🔒⚠ ロックの記録を確認」が出て、人がロックマネージャーで確認するまでAIの編集はすべて止まる
- Git: エディタからプル・コミット・プッシュ。コミットの説明は操作ログから下書き

## ライセンス

[MIT](LICENSE)

## フォルダ構成

```
src/core/     エンジンの核（ブラウザでもNodeでも動く）: 型・住所・差分編集・表・シート・カメラ・音の命令・トゥイーン・シェーダーの宣言・UI の置き方と操作・当たり判定
src/std/      標準の部品（Transform / Sprite / Animator / Shape / Text / Camera / Sound / AudioBus / Particles / Effect / PostEffect / UI / Layout / Button / Gauge / Collider / Clip）と標準の表（$actions / $tweens / $text）
src/render/   描画（WebGL2）
src/audio/    音を鳴らす側（Web Audio。ブラウザ専用）
src/input/    入力の機器（キーボード・マウス・タッチ・ゲームパッド → ボタンの名前と軸の値。ブラウザ専用）
src/mcp/      MCP サーバー
src/project/  プロジェクトの読み書き・操作ログ・ロック・地図（Node専用）
src/cli/      AI向けCLI
src/editor/   エディタ（サーバーとブラウザ側）
examples/     サンプルプロジェクト
test/         テスト
```
