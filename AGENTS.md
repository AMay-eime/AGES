# AGES でAIが作業するときの手順

短く保つこと。このファイル自体がトークンを使う。

## 最初に（毎回）

1. `ages map <dir>` — 全体の地図。コンポーネント・システム・プレハブ・シーン・🔒★の印がすべて載る。ファイルを開いて回る前にこれを読む
2. `ages log <dir>` — 前回から人が何を変えたかの要約。人の調整の意図をくみ取る

`ages` は `node bin/ages.js`（`npm link` で `ages` コマンドになる）。

## 値を変える

- シーン・プレハブの値は `ages set` / `ages patch` で変える。JSONを直接書き換えない（検証とログが通らない）
- `🔒` ロックされた値は変更できない（`--force` でも不可）。変えるべき理由があれば、人に提案する
- `★` 人が調整した値は、変える前に人へ確認し、了承を得てから `--force`
- エラーには範囲や候補（もしかして）が書いてある。読み込み直さず、それに従って直す

## 確かめる

- `ages run <dir> --frames 1800 --keys "0-1800:KeyZ;0-300:ArrowLeft" --watch player.Health.hp --until gameOver`
- 人の操作を再現: `--input recordings/<名前>.input.json`
- 変更後は `--twice` で再現性（毎回同じ結果か）を確認する
- 画面の確認が必要なときだけエディタやスクリーンショットを使う（画像は高い）

## ゲームコードの決まり（game/*.ts）

- 乱数は `ctx.rng`、時間は `ctx.frame` / `ctx.time`。`Math.random` や `Date` は使わない
- システムには `desc` と `reads` / `writes` を書く（地図と依存関係の検索に使われる）
- フィールドには `desc` と、意味のある `min` / `max` を必ず付ける（インスペクタと検証に使われる）
- 実行中だけ変わる値（クールダウンなど）は desc に「自動で変化」と書く

## エディタウインドウ

プロジェクト独自の調整画面は `editor/<名前>.window.ts` に `defineWindow` で書き、`ages.project.json` の `editorWindows` に追加する。例: `examples/shooter/editor/wave-tuner.window.ts`

## 役割分担

面白さの核・手触り・個性を決めるのは人。AIはそれ以外を速く、正確に、少ないトークンで支える。
