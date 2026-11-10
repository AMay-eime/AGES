// 階層の木: シーンの物の UI の親子（DOM なし。テストのため分けた）
import { resolveEntity } from '../core/variant.ts';
import type { EntityData, PrefabDoc } from '../core/docs.ts';

/**
 * 階層の木の親: UI の物は UI.parent、ほかは位置の親（Transform.parent）。プレハブのインスタンスはプレハブの値も見る。
 * 親がシーンにない・自分なら親なし。kind は親子にできる種類（UI どうし・Transform どうし）
 */
export function treeParents(ents: EntityData[], prefabs: Record<string, PrefabDoc>): { parent: Map<string, string>; kind: Map<string, 'UI' | 'Transform'> } {
  const ids = new Set(ents.map((e) => e.id));
  const map = new Map(Object.entries(prefabs));
  const parent = new Map<string, string>();
  const kind = new Map<string, 'UI' | 'Transform'>();
  for (const e of ents) {
    let c = e.components;
    if (e.prefab) { try { c = resolveEntity(map, e).components; } catch { /* プレハブがない */ } }
    const k = c?.UI ? 'UI' : c?.Transform ? 'Transform' : null;
    if (!k) continue;
    kind.set(e.id, k);
    const p = (c[k] as { parent?: unknown }).parent;
    if (typeof p === 'string' && p !== e.id && ids.has(p)) parent.set(e.id, p);
  }
  return { parent, kind };
}

/** 名前の終わりの連番（例 star12 → star・12） */
export const NUMBERED = /^(.*?\D)(\d+)$/;

/** 連番のまとめの開け閉めの鍵（シーン・親・頭の名前） */
export function groupKey(scene: string, under: string, prefix: string): string {
  return `${scene}#~${under}~${prefix}`;
}

/**
 * 兄弟を並べる順に、連番の名前（ID）で子のない物が5つ以上あれば1つにまとめる（見せ方だけ。データは変えない）。
 * まとめは最初の物の場所に置き、中は数の順
 */
export function groupNumbered(list: EntityData[], hasChildren: (id: string) => boolean, min = 5): Array<EntityData | { prefix: string; members: EntityData[] }> {
  const by = new Map<string, EntityData[]>();
  for (const e of list) {
    const m = NUMBERED.exec(e.id);
    if (!m || hasChildren(e.id)) continue;
    if (!by.has(m[1])) by.set(m[1], []);
    by.get(m[1])!.push(e);
  }
  const out: Array<EntityData | { prefix: string; members: EntityData[] }> = [];
  const done = new Set<string>();
  for (const e of list) {
    const m = NUMBERED.exec(e.id);
    const g = m && !hasChildren(e.id) ? by.get(m[1]) : undefined;
    if (!g || g.length < min) { out.push(e); continue; }
    if (done.has(m![1])) continue;
    done.add(m![1]);
    const num = (x: EntityData) => Number(x.id.slice(m![1].length));
    out.push({ prefix: m![1], members: [...g].sort((a, b) => num(a) - num(b)) });
  }
  return out;
}
