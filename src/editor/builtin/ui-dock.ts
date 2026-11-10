// 本体の拡張: UI を画面（親）の端・角に付けるボタン。プロジェクトの拡張と同じ API（部品の見せ方）で書いている
import { defineExtension } from '../window-api.ts';
import { T } from '../i18n.ts';

const EDGES = ['topLeft', 'top', 'topRight', 'left', 'center', 'right', 'bottomLeft', 'bottom', 'bottomRight'];
const MARKS = ['↖', '↑', '↗', '←', T('・'), '→', '↙', '↓', '↘'];

export default defineExtension({
  id: 'ui-dock',
  desc: T('UI を画面（親）の端・角に付けるボタン（押すと anchor と x・y が決まる。隣に付けていたら外れる）'),
  components: [{
    component: 'UI',
    mount(el, comp, api) {
      if (!comp.editable) return;
      const { h } = api;
      const margin = h('input', { type: 'number', min: '0', step: '1', value: localStorage.getItem('ages.dockMargin') ?? '8', style: 'width:48px', title: T('端からの間(px)。0 で接する') }) as HTMLInputElement;
      margin.addEventListener('change', () => localStorage.setItem('ages.dockMargin', margin.value));
      const grid = h('div', { class: 'dock-grid' }, EDGES.map((edge, i) => h('button', {
        class: `icon tiny${comp.values.anchor === edge && !comp.values.beside ? ' on' : ''}`, title: T('{0} に付ける', edge),
        onclick: () => api.patch([{ op: 'dockUI', target: comp.target, edge, margin: Number(margin.value) || 0 }]),
      }, MARKS[i])));
      el.append(h('div', { class: 'field wide' },
        h('label', { title: T('画面（親があれば親）の端・角に付ける。別の UI の隣に付けるなら beside を選ぶ') }, T('端に付ける')),
        h('div', { class: 'ctl', style: 'gap:8px;align-items:center' }, grid, h('span', { class: 'muted' }, T('間')), margin)));
    },
  }],
});
