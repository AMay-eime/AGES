// シーンの編集操作（複製・削除・ずらす・プレハブにする）の操作（op）を作る。
// キーボード（Ctrl+D・Delete・矢印）と右クリックのメニュー（本体の拡張 builtin/entity-menu.ts）が同じものを使う。
import type { Op } from '../core/patch.ts';
import type { EntityData, PrefabDoc, SceneDoc } from '../core/docs.ts';
import { resolveEntity } from '../core/variant.ts';
import { deltaTo, poseOf, type Pose } from '../core/transform.ts';

/** ID の後ろに番号を付けて、まだ使われていない ID にする（enemy → enemy_2） */
export function freshId(base: string, taken: Set<string>): string {
  const stem = base.replace(/_\d+$/, '');
  let i = 2;
  while (taken.has(`${stem}_${i}`)) i++;
  return `${stem}_${i}`;
}

/** 物を複製する（offset だけずらす）。作った物の ID も返す。プレハブのインスタンスは、同じプレハブのインスタンスとして複製する（prefabs で位置を求める） */
export function duplicateOps(scene: SceneDoc, ids: string[], offset = 16, prefabs?: Map<string, PrefabDoc>): { ops: Op[]; ids: string[] } {
  const taken = new Set(scene.entities.map((e) => e.id));
  const ops: Op[] = [];
  const out: string[] = [];
  for (const id of ids) {
    const e = scene.entities.find((x) => x.id === id);
    if (!e) continue;
    const nid = freshId(e.id, taken);
    taken.add(nid);
    const components = structuredClone(e.components);
    // 位置はプレハブと重ねた値から（インスタンスで位置を書いていなくても、ずらした位置を書く）
    let r = e;
    if (e.prefab && prefabs) { try { r = resolveEntity(prefabs, e); } catch { /* プレハブがない */ } }
    if (r.components.Transform) components.Transform = { ...(components.Transform ?? {}), x: Number(r.components.Transform.x ?? 0) + offset, y: Number(r.components.Transform.y ?? 0) + offset };
    else if (r.components.UI) components.UI = { ...(components.UI ?? {}), x: Number(r.components.UI.x ?? 0) + offset, y: Number(r.components.UI.y ?? 0) + offset };
    ops.push({ op: 'addEntity', scene: scene.name, entity: { id: nid, name: e.name, ...(e.prefab ? { prefab: e.prefab } : {}), ...(e.tags?.length ? { tags: [...e.tags] } : {}), ...(e.remove?.length ? { remove: [...e.remove] } : {}), components } });
    out.push(nid);
  }
  return { ops, ids: out };
}

export function removeOps(scene: string, ids: string[]): Op[] {
  return ids.map((id) => ({ op: 'removeEntity', scene, id }));
}

type Tf = Pose & { parent?: string | null };
/** シーンのデータの Transform（書いていない値は既定値）。scene はプレハブと重ねた形（app.sceneView） */
function docTransform(scene: SceneDoc, id: string): Tf | undefined {
  const t = scene.entities.find((e) => e.id === id)?.components.Transform as Partial<Tf> | undefined;
  return t ? { x: Number(t.x ?? 0), y: Number(t.y ?? 0), rot: Number(t.rot ?? 0), sx: Number(t.sx ?? 1), sy: Number(t.sy ?? 1), parent: t.parent ?? null } : undefined;
}

/** シーンのデータでの画面の位置・向き・大きさ（位置の親をたどる）。Transform がなければ null */
export function docPose(scene: SceneDoc, id: string): Pose | null {
  const t = docTransform(scene, id);
  return t ? poseOf((x) => docTransform(scene, x), t) : null;
}

/** 位置の親（Transform.parent）をたどって、ids のどれかの中にあるか（親と一緒に動くので、自分では動かさない） */
export function insideAny(scene: SceneDoc, id: string, ids: Set<string>): boolean {
  for (let p = docTransform(scene, id)?.parent, n = 0; p && n < 64; p = docTransform(scene, p)?.parent, n++) if (ids.has(p)) return true;
  return false;
}

/** 位置（Transform か UI の x・y）を画面で dx・dy だけずらす。Layout で並べている子は動かさない。位置の親がある物は親から見た値に直す（親も動かすなら動かさない） */
export function nudgeOps(scene: SceneDoc, ids: string[], dx: number, dy: number): Op[] {
  const ops: Op[] = [];
  const set = new Set(ids);
  for (const id of ids) {
    const e = scene.entities.find((x) => x.id === id);
    const what = e ? movable(scene, e) : null;
    if (!e || !what) continue;
    const c = e.components[what];
    let ldx = dx, ldy = dy;
    if (what === 'Transform' && c.parent) {
      if (insideAny(scene, id, set)) continue;
      const pp = docPose(scene, String(c.parent));
      if (pp) [ldx, ldy] = deltaTo(pp, dx, dy).map((v) => Math.round(v * 100) / 100) as [number, number];
    }
    const base = `${scene.name}#${id}.${what}`;
    ops.push({ op: 'set', path: `${base}.x`, value: Number(c.x ?? 0) + ldx }, { op: 'set', path: `${base}.y`, value: Number(c.y ?? 0) + ldy });
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
export function prefabOps(e: EntityData, name: string, link?: string): Op[] {
  const components = structuredClone(e.components);
  if (components.Transform) {
    const { x: _x, y: _y, ...rest } = components.Transform;
    components.Transform = rest;
  }
  const add: Op = { op: 'addPrefab', name, components, ...(e.tags?.length ? { tags: [...e.tags] } : {}) };
  // link（シーン#ID）を渡すと、その物を作ったプレハブにつなぐ（位置だけが物の値として残る）
  return link ? [add, { op: 'linkPrefab', target: link, prefab: name }] : [add];
}
