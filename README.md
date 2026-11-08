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
npm run editor

# AI向けCLI
node bin/ages.js map examples/shooter            # プロジェクトの地図
node bin/ages.js get examples/shooter main#player # 値を見る
node bin/ages.js set examples/shooter main#player.Mover.speed 5
node bin/ages.js run examples/shooter --frames 600 --watch main#player.Health.hp
node bin/ages.js log examples/shooter            # 前回からの編集の要約
```
