// 本体の拡張: シーンの物の右クリックのメニュー（複製・削除・プレハブにする）。プロジェクトの拡張と同じ API（menus）で書いている。
// キーボード（Ctrl+D・Delete）も同じ操作（edit-ops.ts）を使う
import { defineExtension } from '../window-api.ts';
import { duplicateOps, prefabOps, removeOps } from '../edit-ops.ts';
import { resolveEntity } from '../../core/variant.ts';
import { parseAddress } from '../../core/docs.ts';
import { T } from '../i18n.ts';

/** 住所の並び → シーンの名前と ID の並び（同じシーンのものだけ） */
const split = (targets: string[]) => {
  const as = targets.map((t) => parseAddress(t)).filter((a) => a.kind === 'scene');
  return { scene: as[0]?.doc ?? '', ids: as.filter((a) => a.doc === as[0].doc).map((a) => a.entity!) };
};

export default defineExtension({
  id: 'entity-menu',
  desc: T('シーンの物の右クリックのメニュー（複製・削除・プレハブにする）'),
  menus: [
    {
      label: T('複製（Ctrl+D）'), where: 'entity',
      when: (_t, api) => !api.playing,
      async run(targets, api) {
        const { scene, ids } = split(targets);
        const doc = api.state.scenes[scene];
        if (!doc) return;
        const r = duplicateOps(doc, ids, 16, new Map(Object.entries(api.state.prefabs)));
        if (await api.patch(r.ops)) r.ids.forEach((id, i) => api.select(`${scene}#${id}`, i > 0));
      },
    },
    {
      label: T('削除（Delete）'), where: 'entity',
      when: (_t, api) => !api.playing,
      async run(targets, api) {
        const { scene, ids } = split(targets);
        if (!ids.length || !confirm(ids.length > 1 ? T('{0}体を削除しますか？（{1}）', ids.length, ids.join(', ')) : T('{0}#{1} を削除しますか？', scene, ids[0]))) return;
        if (await api.patch(removeOps(scene, ids))) api.select(null);
      },
    },
    {
      label: T('プレハブにする'), where: 'entity',
      when: (t, api) => t.length === 1 && !api.playing,
      async run(targets, api) {
        const { scene, ids } = split(targets);
        const raw = api.state.scenes[scene]?.entities.find((x) => x.id === ids[0]);
        if (!raw) return;
        // インスタンスなら、プレハブと重ねた今の中身から作る。作った後、この物は新しいプレハブにつながる（位置だけが物の値として残る）
        let e = raw;
        try { e = resolveEntity(new Map(Object.entries(api.state.prefabs)), raw); } catch { /* プレハブがない: 書いてある値だけで */ }
        const name = await api.ask(T('プレハブの名前（英数字・_・-）'), e.id.replace(/[^A-Za-z0-9_-]/g, '_'));
        if (!name) return;
        if (await api.patch(prefabOps(e, name, `${scene}#${e.id}`))) { api.notify(T('@{0} を作り、{1} をつなぎました（コードからは ctx.spawn(\'{2}\')）', name, e.id, name)); api.select(`@${name}`); }
      },
    },
  ],
});
