// 実行中のエンティティの集まり。挿入順で回るので結果は毎回同じになる。
import type { Registry } from './registry.ts';
import type { EntityData } from './docs.ts';
import { poseOf, relativeTo, type Pose } from './transform.ts';
import { expandChildren, hasChildren, prefabChildren } from './variant.ts';

export interface Entity {
  id: string;
  name: string;
  tags: string[];
  /** 生成元のプレハブ名（シーンに置かれたものは undefined） */
  prefab?: string;
  c: Record<string, Record<string, any>>;
}

export class World {
  readonly entities = new Map<string, Entity>();
  readonly registry: Registry;
  private seq = 0;
  private doomed = new Set<string>();

  constructor(registry: Registry) {
    this.registry = registry;
  }

  /** データからエンティティを作る（コンポーネントは既定値で補完・検証） */
  add(data: EntityData, prefab?: string): Entity {
    if (this.entities.has(data.id)) throw new Error(`エンティティID ${data.id} が重複しています`);
    const c: Entity['c'] = {};
    for (const [name, values] of Object.entries(data.components)) {
      c[name] = this.registry.build(name, values, data.id);
    }
    const e: Entity = { id: data.id, name: data.name, tags: [...(data.tags ?? [])], prefab, c };
    this.entities.set(e.id, e);
    return e;
  }

  /** プレハブから生成する。overrides は { Transform: { x: 10 } } の形。 */
  spawn(prefabName: string, overrides: Record<string, Record<string, unknown>> = {}): Entity {
    const p = this.registry.prefab(prefabName);
    const components: EntityData['components'] = {};
    for (const [name, values] of Object.entries(p.components)) components[name] = { ...values };
    for (const [name, values] of Object.entries(overrides)) components[name] = { ...(components[name] ?? {}), ...values };
    const id = `${prefabName}~${++this.seq}`;
    const e = this.add({ id, name: p.name, tags: p.tags, components }, prefabName);
    this.addChildren(e, prefabName);
    return e;
  }

  /** 子を持つプレハブなら、子（と孫）も出す。ID は 親のID/名前（シーンに置いた物にも使う） */
  addChildren(e: Entity, prefabName: string): void {
    if (!hasChildren(this.registry.prefabs, prefabName)) return;
    for (const d of expandChildren(prefabChildren(this.registry.prefabs, prefabName), e.id, !!e.c.Transform3D && !e.c.Transform)) this.add(d, d.prefab);
  }

  /** 子（ID は 親のID/名前。孫は 'gun_l/muzzle' のように / でつなぐ）。いなければ undefined */
  child(parent: Entity | string, path: string): Entity | undefined {
    const id = `${typeof parent === 'string' ? parent : parent.id}/${path}`;
    return this.isAlive(id) ? this.entities.get(id) : undefined;
  }

  /** フレームの終わりにまとめて消す */
  destroy(id: string): void {
    if (this.entities.has(id)) this.doomed.add(id);
  }

  isAlive(id: string): boolean {
    return this.entities.has(id) && !this.doomed.has(id);
  }

  flush(): void {
    if (!this.doomed.size) return;
    // 位置の親（Transform.parent）が消える子も一緒に消す（孫も）
    for (let more = true; more;) {
      more = false;
      for (const e of this.entities.values()) {
        // Transform3D は追加パッケージ 3d の位置（入れていなければ、どの物にもない）
        const p = e.c.Transform?.parent ?? e.c.Transform3D?.parent;
        if (p && this.doomed.has(p) && !this.doomed.has(e.id)) { this.doomed.add(e.id); more = true; }
      }
    }
    for (const id of this.doomed) this.entities.delete(id);
    this.doomed.clear();
  }

  /**
   * 画面（ワールド）の位置・向き・大きさ。位置の親（Transform.parent）があれば親をたどって求める。
   * 親がなければ Transform そのものを返す（作り直さない。書き換えないこと）。Transform がなければ null
   */
  pose(e: Entity | string): Pose | null {
    const x = typeof e === 'string' ? this.entities.get(e) : e;
    const t = x?.c.Transform as (Pose & { parent?: string | null }) | undefined;
    if (!t) return null;
    return t.parent ? poseOf((id) => this.entities.get(id)?.c.Transform as Pose | undefined, t) : t;
  }

  /** 画面のこの位置に置く（親があれば、親から見た位置に直して書く） */
  setWorldPos(e: Entity | string, x: number, y: number): void {
    this.setWorld(e, { x, y });
  }

  /** 画面の位置・向き・大きさを決めて置く（渡した値だけ。親があれば、親から見た値に直して書く） */
  setWorld(e: Entity | string, w: Partial<Pose>): void {
    const ent = typeof e === 'string' ? this.entities.get(e) : e;
    const t = ent?.c.Transform;
    if (!ent || !t) return;
    const parent = t.parent ? this.entities.get(t.parent) : undefined;
    const pos = w.x !== undefined || w.y !== undefined;
    if (!parent?.c.Transform) {
      if (pos) { t.x = w.x ?? t.x; t.y = w.y ?? t.y; }
      if (w.rot !== undefined) t.rot = w.rot;
      if (w.sx !== undefined) t.sx = w.sx;
      if (w.sy !== undefined) t.sy = w.sy;
      return;
    }
    const cur = this.pose(ent)!;
    const local = relativeTo(this.pose(parent)!, { x: w.x ?? cur.x, y: w.y ?? cur.y, rot: w.rot ?? cur.rot, sx: w.sx ?? cur.sx, sy: w.sy ?? cur.sy });
    if (pos) { t.x = local.x; t.y = local.y; }
    if (w.rot !== undefined) t.rot = local.rot;
    if (w.sx !== undefined) t.sx = local.sx;
    if (w.sy !== undefined) t.sy = local.sy;
  }

  /** 位置の親を変える（null で親なし）。画面の位置・向き・大きさはそのまま。親の中にある物を親にはできない */
  attach(child: Entity | string, parent: Entity | string | null): void {
    const c = typeof child === 'string' ? this.entities.get(child) : child;
    const t = c?.c.Transform;
    if (!c || !t) return;
    const pid = parent === null ? null : typeof parent === 'string' ? parent : parent.id;
    const p = pid ? this.entities.get(pid) : undefined;
    if (pid && !p?.c.Transform) throw new Error(`attach: 親 ${pid} がないか、Transform がありません`);
    for (let a = p, n = 0; a && n < 64; a = a.c.Transform?.parent ? this.entities.get(a.c.Transform.parent) : undefined, n++) {
      if (a.id === c.id) throw new Error(`attach: ${pid} は ${c.id} の中にあるので、親にできません`);
    }
    const w = { ...this.pose(c)! };
    const local = p ? relativeTo(this.pose(p)!, w) : w;
    t.parent = pid;
    t.x = local.x; t.y = local.y; t.rot = local.rot; t.sx = local.sx; t.sy = local.sy;
  }

  get(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  /** 指定コンポーネントをすべて持つ、生きているエンティティ */
  query(...components: string[]): Entity[] {
    // 毎フレーム何度も呼ばれるので、関数を作らずに回す（コンポーネント1つ・2つは専用の道）
    const out: Entity[] = [];
    const doomed = this.doomed.size ? this.doomed : null;
    const n = components.length;
    if (n === 1) {
      const a = components[0];
      for (const e of this.entities.values()) if (a in e.c && !(doomed && doomed.has(e.id))) out.push(e);
      return out;
    }
    if (n === 2) {
      const a = components[0], b = components[1];
      for (const e of this.entities.values()) if (a in e.c && b in e.c && !(doomed && doomed.has(e.id))) out.push(e);
      return out;
    }
    outer: for (const e of this.entities.values()) {
      if (doomed && doomed.has(e.id)) continue;
      for (let i = 0; i < n; i++) if (!(components[i] in e.c)) continue outer;
      out.push(e);
    }
    return out;
  }

  tagged(tag: string): Entity[] {
    return [...this.entities.values()].filter((e) => !this.doomed.has(e.id) && e.tags.includes(tag));
  }

  /** 状態の書き出し（保存・比較・AIが読む用） */
  snapshot(): { seq: number; entities: Entity[] } {
    return { seq: this.seq, entities: structuredClone([...this.entities.values()]) };
  }

  restore(snap: { seq: number; entities: Entity[] }): void {
    this.entities.clear();
    this.doomed.clear();
    this.seq = snap.seq;
    for (const e of structuredClone(snap.entities)) this.entities.set(e.id, e);
  }
}
