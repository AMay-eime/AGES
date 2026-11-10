# CLAUDE.md

このリポジトリは AGES（AIが扱いやすいゲームエンジン兼エディタ）。理念は「とにかくゲーム開発のスピードを上げる」。

## 作業を始める前に読む（この順番）
1. [docs/VISION.md](docs/VISION.md) — 開発理念と原則
2. [docs/PLAN.md](docs/PLAN.md) — 企画書。冒頭の「現在地」が今やるべきこと
3. [docs/DECISIONS.md](docs/DECISIONS.md) — これまでの決定と理由（覆す前に必ず確認）
4. [docs/PROCEDURES.md](docs/PROCEDURES.md) — 作業の流れと、機能を足すときの決まり

AGESを使ってゲームを作る作業なら [AGENTS.md](AGENTS.md) に従う。

## 必ず守ること
- 作業の最後に PLAN.md の「現在地」と DECISIONS.md を更新する
- `npm test` を通してからコミットする
- 今までのプロジェクトに直しが要る変更をしたら、docs/MIGRATIONS.md に直し方を足して `COMPAT` を上げる
- 🔒ロックをAIの経路から設定・解除・回避できる機能は作らない
- 面白さの核・手触り・個性は人が決める
