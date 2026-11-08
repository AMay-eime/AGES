// {{name}} のゲームコード。EDITOR-PLAN.md の合意の後に、コンポーネントとシステムを足していく。
// 決まり: 乱数は ctx.rng、時間は ctx.frame。各フィールドに desc と意味のある min/max を付ける（AGENTS.md）
// Transform・Sprite・Animator・Shape・Text は標準で用意されている（ages map の「標準」、詳細は ages schema）
import type { GameModule } from 'ages';

/** このゲームのコンポーネント（defineComponent で作って並べる） */
export const components: GameModule['components'] = [];

/** 実行順に並べる */
export const systems: GameModule['systems'] = [];
