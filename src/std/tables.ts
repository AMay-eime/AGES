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

export const tweens = defineTable({
  name: 'tweens',
  desc: 'トゥイーン（値を時間で変える）の手触り（標準）。ゲームのコードは ctx.tween(物, { "Sprite.alpha": 0 }, "fadeOut") のように名前で使う',
  columns: {
    time: { type: 'number', default: 0.3, min: 0, max: 60, step: 0.01, desc: 'かける秒数（片道）' },
    ease: { type: 'ease', default: 'outQuad', desc: '変わり方' },
    delay: { type: 'number', default: 0, min: 0, max: 60, step: 0.01, desc: '始めるまでの秒数' },
    repeat: { type: 'int', default: 0, min: -1, max: 1000, desc: 'くり返す回数（-1 で止めるまで）' },
    yoyo: { type: 'bool', default: false, desc: '行って戻る（くり返すたびに向きが変わる）' },
    desc: { type: 'string', default: '', desc: '何に使うか' },
  },
});

/** 言葉（多言語）。列は config.languages の言語ごとに作る */
export function textTable(languages: string[]) {
  return defineTable({
    name: 'text',
    desc: '言葉（多言語。標準）。行の名前で引く: ゲームのコードは ctx.t("名前", { 値 })、文字の物は Text.key に名前。{名前} の所に値が入る。列は言語（ages.project.json の languages。最初が既定）',
    columns: {
      ...Object.fromEntries(languages.map((l, i) => [l, { type: 'string' as const, default: '', desc: `${l} の言葉${i === 0 ? '（既定の言語。ほかの言語の訳がないときはこれを出す）' : ''}` }])),
      desc: { type: 'string', default: '', desc: 'どこに出る言葉か（訳す人・AI への説明）' },
    },
  });
}

export const text = textTable(['ja']);

export const STD_TABLES = [actions, tweens, text];
