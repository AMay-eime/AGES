// 本体の拡張: 階層のプレハブの右クリックのメニュー（写す・名前を変える・削除）。プロジェクトの拡張と同じ API（menus の where: 'prefab'）で書いている。
// 派生を作る・切り離すはインスペクタの帯。名前を変えると、指している値・派生の元・インスタンスも直る（renamePrefab）
import { defineExtension } from '../window-api.ts';

const nameOf = (targets: string[]) => (targets[0]?.startsWith('@') ? targets[0].slice(1) : '');

/** まだ使っていない名前（x_copy・x_copy2 …） */
const freeName = (name: string, taken: Record<string, unknown>) => {
  let n = `${name}_copy`;
  for (let i = 2; n in taken; i++) n = `${name}_copy${i}`;
  return n;
};

export default defineExtension({
  id: 'prefab-menu',
  desc: '階層のプレハブの右クリックのメニュー（写す・名前を変える・削除）',
  menus: [
    {
      label: '写す', where: 'prefab',
      when: (t, api) => !api.playing && !!nameOf(t),
      async run(targets, api) {
        const name = nameOf(targets);
        const to = await api.ask(`@${name} を写す（元とつながらない写し。つながったものは「＋派生を作る」）。新しい名前`, freeName(name, api.state.prefabs));
        if (to && (await api.patch([{ op: 'addPrefab', name: to, copy: name }]))) api.select(`@${to}`);
      },
    },
    {
      label: '名前を変える', where: 'prefab',
      when: (t, api) => !api.playing && !!nameOf(t),
      async run(targets, api) {
        const name = nameOf(targets);
        const to = await api.ask(`@${name} の新しい名前（指している値・派生の元も直る。コードの中は直さない）`, name);
        if (to && to !== name && (await api.patch([{ op: 'renamePrefab', name, to }]))) api.select(`@${to}`);
      },
    },
    {
      label: '削除', where: 'prefab',
      when: (t, api) => !api.playing && !!nameOf(t),
      async run(targets, api) {
        const name = nameOf(targets);
        if (!confirm(`@${name} を削除しますか？（使われているもの・派生の元は消せません）`)) return;
        if (await api.patch([{ op: 'removePrefab', name }])) api.select(null);
      },
    },
  ],
});
