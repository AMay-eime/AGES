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
- AIがAGESでゲームを作るときの手順: [AGENTS.md](AGENTS.md)

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
node bin/ages.js get examples/shooter main#player # 値を見る
node bin/ages.js set examples/shooter main#player.Player.speed 5
node bin/ages.js table examples/shooter enemies  # 表を見る（$enemies.basic.hp のように住所で読み書き）
node bin/ages.js sheet examples/shooter assets/kenney-pixel-shmup/ships.png  # 画像の切り方
node bin/ages.js run examples/shooter --frames 600 --watch main#player.Health.hp
node bin/ages.js log examples/shooter            # 前回からの編集の要約
```

## MCP（AIのアプリから直接使う）

`ages init` で作ったプロジェクトには `.mcp.json` が入っていて、Claude Code などで開けば自動でつながります。手動で足す場合:

```sh
claude mcp add ages -- node /path/to/AGES/src/mcp/server.ts --project /path/to/my-game
```

使用者のPC上で動く小さなプログラムで、ネット上のサーバーは要りません。

## エディタでできること

- 階層・プロジェクト（ファイル一覧、ドロップで assets/ に追加）・インスペクタ・ゲーム・テキスト・操作ログ・Git
- インスペクタはコンポーネントの宣言から自動生成。各値に 🔒 ロック（AIは変更不可）を付けられる。「🔒を隠す」でロック済みの値を非表示にできる
- 2次元行列のパラメータは専用の行列エディタで編集（表計算ソフトからの貼り付け、別ウインドウ表示に対応）
- リスト・構造体・どれか1つ（命令の列など）は、インスペクタの中でそのまま編集（足す・消す・並べ替え）
- 表（武器・敵・カードなど同じ形の行が並ぶデータ）は表のエディタで。セルの直接編集、表計算ソフトからの貼り付け、CSV の書き出し・読み込み、セル・行ごとのロック
- 画像の切り方（スプライトエディタ）: 格子・数・自動で切る、矩形の編集、基準点、動き
- 標準の部品: 画像・アニメーション・図形・文字・カメラ（追いかけ・揺れ・複数）・音（区分・BGM の重ね）
- 再生・一時停止・1フレーム送り。実行中に変えた値は、停止時に保存するか選べる
- 「記録して再生」で入力を recordings/ に保存。AIは `ages run --input` で同じ操作を再現できる
- ゲーム画面でクリックして選択（重なっていれば同じ場所をもう一度クリックで奥へ）、ドラッグで移動。カメラの視点と自由な視点、画面の形の切り替え
- タブはドラッグで別の場所へ移動でき、境界線で大きさを変えられる（配置は .ages/layout.json に保存）
- プロジェクト独自のウインドウ（`editor/*.window.ts`）を追加できる
- 外部（別のエディタやAI）でファイルが書き換えられると即座に反映。ロックされた値は自動で元に戻る
- ロックの記録そのものが書き換えられると「🔒⚠ ロックの記録を確認」が出て、人が確認するまでAIの編集はすべて止まる
- Git: エディタからプル・コミット・プッシュ。コミットの説明は操作ログから下書き

## ライセンス

[MIT](LICENSE)

## フォルダ構成

```
src/core/     エンジンの核（ブラウザでもNodeでも動く）: 型・住所・差分編集・表・シート・カメラ・音の命令
src/std/      標準の部品（Transform / Sprite / Animator / Shape / Text / Camera / Sound / AudioBus）
src/render/   描画（WebGL2）
src/audio/    音を鳴らす側（Web Audio。ブラウザ専用）
src/mcp/      MCP サーバー
src/project/  プロジェクトの読み書き・操作ログ・ロック・地図（Node専用）
src/cli/      AI向けCLI
src/editor/   エディタ（サーバーとブラウザ側）
examples/     サンプルプロジェクト
test/         テスト
```
