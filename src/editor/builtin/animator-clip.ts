// 本体の拡張: Animator.clip を、画像の切り方にある動きから選ぶ。プロジェクトの拡張と同じ API（欄の見せ方）で書いている
import { defineExtension } from '../window-api.ts';
import { T } from '../i18n.ts';

export default defineExtension({
  id: 'animator-clip',
  desc: T('Animator.clip を、同じ物の Sprite の画像の切り方にある動きから選ぶ（コマ数・速さ付き）'),
  fields: [{
    match: 'Animator.clip',
    mount(el, field, api) {
      const image = field.holder.Sprite?.image;
      const clips = (typeof image === 'string' && image ? api.sheet(image)?.clips : undefined) ?? {};
      const names = Object.keys(clips);
      // 動きがなければ、標準の欄（文字で入れる）
      if (!names.length) { el.append(field.standard()); return; }
      const value = String(field.value);
      const options = names.includes(value) ? names : [value, ...names];
      const sel = api.h('select', {}, options.map((o) => api.h('option', { value: o, selected: o === value }, names.includes(o) ? T('{0}（{1}コマ {2}fps）', o, clips[o].frames.length, clips[o].fps) : T('{0}（シートにありません）', o)))) as HTMLSelectElement;
      sel.addEventListener('change', () => field.set(sel.value));
      el.append(sel);
    },
  }],
});
