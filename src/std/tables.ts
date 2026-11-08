// 標準の表。どのプロジェクトでも使える（data/<名前>.table.json に中身を置く。なければ空の表）。
import { defineTable } from '../core/table.ts';

export const actions = defineTable({
  name: 'actions',
  desc: '操作の名前と割り当て（標準）。ゲームのコードは ctx.input.pressed("fire") のように名前で読む。割り当てはゲームの中から変えられる（キーコンフィグ）',
  columns: {
    kind: { type: 'enum', options: ['button', 'axis'], default: 'button', desc: 'button: 押す・離す。axis: -1〜1 の値（keys で +、negative で −、analog でスティック）' },
    keys: { type: 'list', of: { type: 'input', default: '' }, default: [], desc: '割り当てるボタン（axis では + の向き）' },
    negative: { type: 'list', of: { type: 'input', default: '' }, default: [], desc: 'axis の − の向きのボタン' },
    analog: { type: 'list', of: { type: 'input', default: '', analog: true }, default: [], desc: 'アナログの軸（例 Pad.LX）' },
    deadzone: { type: 'number', default: 0.2, min: 0, max: 0.95, step: 0.05, desc: 'スティックの遊び（これより小さく倒しても 0）' },
    desc: { type: 'string', default: '', desc: 'この操作の説明（キーコンフィグの画面に出す名前など）' },
  },
});

export const STD_TABLES = [actions];
