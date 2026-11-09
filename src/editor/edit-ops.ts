// シーンの編集操作（複製・削除・ずらす・プレハブにする）の操作（op）を作る。
// キーボード（Ctrl+D・Delete・矢印）と右クリックのメニュー（本体の拡張 builtin/entity-menu.ts）が同じものを使う。
import type { Op } from '../core/patch.ts';
import type { EntityData, SceneDoc } from '../core/docs.ts';

/** ID の後ろに番号を付けて、まだ使われていない ID にする（enemy → enemy_2） */
export function freshId(base: string, taken: Set<string>): string {
  const stem = base.replace(/_\d+$/, '');
  let i = 2;
  while (taken.has(`${stem}_${i}`)) i++;
  return `${stem}_${i}`;
}

/** 物を複製する（offset だけずらす）。作った物の ID も返す */
export function duplicateOps(scene: SceneDoc, ids: string[], offset = 16): { ops: Op[]; ids: string[] } {
  const taken = new Set(scene.entities.map((e) => e.id));
  const ops: Op[] = [];
  const out: string[] = [];
  for (const id of ids) {
    const e = scene.entities.find((x) => x.id === id);
    if (!e) continue;
    const nid = freshId(e.id, taken);
    taken.add(nid);
    const components = structuredClone(e.components);
    if (components.Transform) components.Transform = { ...components.Transform, x: Number(components.Transform.x ?? 0) + offset, y: Number(components.Transform.y ?? 0) + offset };
    else if (components.UI) components.UI = { ...components.UI, x: Number(components.UI.x ?? 0) + offset, y: Number(components.UI.y ?? 0) + offset };
    ops.push({ op: 'addEntity', scene: scene.name, entity: { id: nid, name: e.name, ...(e.tags?.length ? { tags: [...e.tags] } : {}), components } });
    out.push(nid);
  }
  return { ops, ids: out };
}

export function removeOps(scene: string, ids: string[]): Op[] {
  return ids.map((id) => ({ op: 'removeEntity', scene, id }));
}

/** 位置（Transform か UI の x・y）を dx・dy だけずらす。Layout で並べている子は動かさない */
export function nudgeOps(scene: SceneDoc, ids: string[], dx: number, dy: number): Op[] {
  const ops: Op[] = [];
  for (const id of ids) {
    const e = scene.entities.find((x) => x.id === id);
    const what = e ? movable(scene, e) : null;
    if (!e || !what) continue;
    const c = e.components[what];
    const base = `${scene.name}#${id}.${what}`;
    ops.push({ op: 'set', path: `${base}.x`, value: Number(c.x ?? 0) + dx }, { op: 'set', path: `${base}.y`, value: Number(c.y ?? 0) + dy });
  }
  return ops;
}

/** 動かすときに変える部品（UI なら UI の x・y、なければ Transform）。動かせなければ null */
export function movable(scene: SceneDoc, e: EntityData): 'UI' | 'Transform' | null {
  if (e.components.UI) {
    const parent = e.components.UI.parent ? scene.entities.find((x) => x.id === e.components.UI.parent) : undefined;
    return parent?.components.Layout ? null : 'UI';
  }
  return e.components.Transform ? 'Transform' : null;
}

/** 物からプレハブを作る（位置は出すときに決めるので x・y は入れない） */
export function prefabOps(e: EntityData, name: string): Op[] {
  const components = structuredClone(e.components);
  if (components.Transform) {
    const { x: _x, y: _y, ...rest } = components.Transform;
    components.Transform = rest;
  }
  return [{ op: 'addPrefab', name, components, ...(e.tags?.length ? { tags: [...e.tags] } : {}) }];
}
