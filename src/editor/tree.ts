// 階層の木: シーンの物の UI の親子（DOM なし。テストのため分けた）
import { resolveEntity } from '../core/variant.ts';
import type { EntityData, PrefabDoc } from '../core/docs.ts';

/** シーンの物の UI の親（UI.parent。プレハブのインスタンスはプレハブの値も見る）。親がシーンにない・自分なら親なし */
export function uiParents(ents: EntityData[], prefabs: Record<string, PrefabDoc>): { parent: Map<string, string>; hasUI: Set<string> } {
  const ids = new Set(ents.map((e) => e.id));
  const map = new Map(Object.entries(prefabs));
  const parent = new Map<string, string>();
  const hasUI = new Set<string>();
  for (const e of ents) {
    let c = e.components;
    if (e.prefab) { try { c = resolveEntity(map, e).components; } catch { /* プレハブがない */ } }
    const ui = c?.UI as { parent?: unknown } | undefined;
    if (!ui) continue;
    hasUI.add(e.id);
    if (typeof ui.parent === 'string' && ui.parent !== e.id && ids.has(ui.parent)) parent.set(e.id, ui.parent);
  }
  return { parent, hasUI };
}
