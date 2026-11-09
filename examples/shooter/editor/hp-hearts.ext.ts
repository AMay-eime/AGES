// プロジェクト独自のエディタ拡張の例（インスペクタの欄の見せ方）: 体力を ♥ の数で見せ、−・＋ で1つずつ変える。
// 欄の見せ方は fields に書く。match は 型（'color'）・部品.フィールド（'Health.hp'）・住所（'main#player.Health.hp'）のどれか
import { defineExtension } from 'ages';

export default defineExtension({
  id: 'hp-hearts',
  desc: '体力（Health.hp）を ♥ の数で見せ、−・＋ で1つずつ変える',
  fields: [{
    match: 'Health.hp',
    mount(el, field, api) {
      const { h } = api;
      const hp = Number(field.value);
      const max = field.def.type === 'int' && field.def.max !== undefined ? field.def.max : Infinity;
      const hearts = h('span', { style: 'color:#ff5d73;letter-spacing:1px', title: `${hp}` }, hp <= 10 ? '♥'.repeat(Math.max(0, hp)) || '（0）' : `♥×${hp}`);
      const step = (d: number) => () => field.set(Math.min(max, Math.max(0, hp + d)));
      el.append(
        h('button', { class: 'tiny', disabled: field.locked || hp <= 0, onclick: step(-1) }, '−'),
        hearts,
        h('button', { class: 'tiny', disabled: field.locked || hp >= max, onclick: step(1) }, '＋'),
        field.standard(),
      );
    },
  }],
});
