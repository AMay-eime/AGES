// 実行中のエンティティの集まり。挿入順で回るので結果は毎回同じになる。
import type { Registry } from './registry.ts';
import type { EntityData } from './docs.ts';

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
    return this.add({ id, name: p.name, tags: p.tags, components }, prefabName);
  }

  /** フレームの終わりにまとめて消す */
  destroy(id: string): void {
    if (this.entities.has(id)) this.doomed.add(id);
  }

  isAlive(id: string): boolean {
    return this.entities.has(id) && !this.doomed.has(id);
  }

  flush(): void {
    for (const id of this.doomed) this.entities.delete(id);
    this.doomed.clear();
  }

  get(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  /** 指定コンポーネントをすべて持つ、生きているエンティティ */
  query(...components: string[]): Entity[] {
    const out: Entity[] = [];
    for (const e of this.entities.values()) {
      if (this.doomed.has(e.id)) continue;
      if (components.every((n) => n in e.c)) out.push(e);
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
