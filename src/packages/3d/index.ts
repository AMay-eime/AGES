// 追加パッケージ 3d（公式）。ゲームのコードからは import { … } from 'ages/3d'。
// ages.project.json の packages に "3d" を書いたプロジェクトでだけ読み込まれる。
// 作る順番は docs/PLAN.md の段階4（いまは仕組みだけ。部品はこれから足す）
import { definePackage } from '../../core/packages.ts';

export default definePackage({
  name: '3d',
  desc: '3D（作っている途中。いまは仕組みだけで、部品はまだない）',
  components: [],
  systems: [],
  toc: [
    '3D の全体（座標は Y が上・単位はメートル。2D の UI はそのまま上に重なる） → `3d`',
  ],
});
