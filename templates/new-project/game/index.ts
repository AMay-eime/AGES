// {{name}} のゲームコード。EDITOR-PLAN.md の合意の後に、コンポーネントとシステムを足していく。
// 決まり: 乱数は ctx.rng、時間は ctx.frame。各フィールドに desc と意味のある min/max を付ける（AGENTS.md）
import { defineComponent, type GameModule } from 'ages';

export const Transform = defineComponent({
  name: 'Transform',
  desc: '位置と向き',
  fields: {
    x: { type: 'number', default: 0, desc: '横位置(px)' },
    y: { type: 'number', default: 0, desc: '縦位置(px)' },
    rot: { type: 'number', default: 0, min: -360, max: 360, desc: '回転(度)' },
  },
});

export const Shape = defineComponent({
  name: 'Shape',
  desc: '単色の図形として描く（当たり判定の大きさにも使う）',
  fields: {
    kind: { type: 'enum', options: ['rect', 'circle'], default: 'rect', desc: '形' },
    w: { type: 'number', default: 16, min: 1, max: 512, desc: '幅(px)' },
    h: { type: 'number', default: 16, min: 1, max: 512, desc: '高さ(px)' },
    color: { type: 'color', default: '#ffffff', desc: '色' },
  },
});

export const components: GameModule['components'] = [Transform, Shape];

/** 実行順に並べる */
export const systems: GameModule['systems'] = [];
