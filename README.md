# AGES

**All Games should be Edited Speedy** — AIと人が一緒に、速く、少ないトークンでゲームを作るためのゲームエンジン兼エディタ。

- 正本はすべてテキスト（JSON / TypeScript）。人はエディタで、AIはCLIで、同じファイルを編集する
- 画面なしで高速に実行し、結果の要約だけを返す（`ages run`）
- 固定更新・シード付き乱数・入力の記録と再生で、毎回同じ結果になる
- 人とAIのすべての編集を操作ログに残し、人が調整した値はAIが勝手に上書きしない
- 実行時の外部依存ゼロ。コンパイル待ちなし

設計の詳細は [DESIGN.md](DESIGN.md)、AIが作業するときの手順は [AGENTS.md](AGENTS.md) を参照。

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
node bin/ages.js map examples/shooter            # プロジェクトの地図
node bin/ages.js get examples/shooter main#player # 値を見る
node bin/ages.js set examples/shooter main#player.Mover.speed 5
node bin/ages.js run examples/shooter --frames 600 --watch main#player.Health.hp
node bin/ages.js log examples/shooter            # 前回からの編集の要約
```

## エディタでできること（段階1）

- 階層・プロジェクト（ファイル一覧、ドロップで assets/ に追加）・インスペクタ・ゲーム・テキスト・操作ログ・Git
- インスペクタはコンポーネントの宣言から自動生成。各値に 🔒 ロック（AIは変更不可）を付けられる
- 再生・一時停止・1フレーム送り。実行中に変えた値は、停止時に保存するか選べる
- 「記録して再生」で入力を recordings/ に保存。AIは `ages run --input` で同じ操作を再現できる
- ゲーム画面でクリックして選択、ドラッグで移動
- タブはドラッグで別の場所へ移動でき、境界線で大きさを変えられる（配置は .ages/layout.json に保存）
- プロジェクト独自のウインドウ（`editor/*.window.ts`）を追加できる
- 外部（別のエディタやAI）でファイルが書き換えられると即座に反映。ロックされた値は自動で元に戻る
- Git: エディタからプル・コミット・プッシュ。コミットの説明は操作ログから下書き

## フォルダ構成

```
src/core/     エンジンの核（ブラウザでもNodeでも動く）
src/render/   描画（Canvas 2D）
src/project/  プロジェクトの読み書き・操作ログ・ロック・地図（Node専用）
src/cli/      AI向けCLI
src/editor/   エディタ（サーバーとブラウザ側）
examples/     サンプルプロジェクト
test/         テスト
```
