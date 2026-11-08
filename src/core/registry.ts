// コンポーネント・システム・プレハブの登録簿。
import { checkComponent, defaultsOf, suggest, type ComponentDef } from './schema.ts';
import type { PrefabDoc } from './docs.ts';
import type { Ctx } from './game.ts';

export interface SystemDef {
  name: string;
  /** 何をするシステムか（地図に載る一行説明） */
  desc: string;
  /** 読むコンポーネント（依存関係の検索に使う） */
  reads?: string[];
  /** 書き換えるコンポーネント */
  writes?: string[];
  /** シーン開始時に1回 */
  start?(ctx: Ctx): void;
  /** 毎フレーム */
  update(ctx: Ctx): void;
}

export function defineSystem<T extends SystemDef>(def: T): T {
  return def;
}

/** game/index.ts が export する形 */
export interface GameModule {
  components: ComponentDef[];
  systems: SystemDef[];
}

export class Registry {
  components = new Map<string, ComponentDef>();
  systems: SystemDef[] = [];
  prefabs = new Map<string, PrefabDoc>();

  static from(mod: GameModule, prefabs: Iterable<PrefabDoc> = []): Registry {
    const r = new Registry();
    for (const c of mod.components) {
      if (r.components.has(c.name)) throw new Error(`コンポーネント ${c.name} が2回定義されています`);
      r.components.set(c.name, c);
    }
    const names = new Set<string>();
    for (const s of mod.systems) {
      if (names.has(s.name)) throw new Error(`システム ${s.name} が2回定義されています`);
      names.add(s.name);
      for (const c of [...(s.reads ?? []), ...(s.writes ?? [])]) {
        if (!r.components.has(c)) throw new Error(`システム ${s.name} が未定義のコンポーネント ${c} を参照しています${suggest(c, [...r.components.keys()])}`);
      }
      r.systems.push(s);
    }
    for (const p of prefabs) r.prefabs.set(p.name, p);
    return r;
  }

  component(name: string): ComponentDef {
    const c = this.components.get(name);
    if (!c) throw new Error(`コンポーネント ${name} はありません${suggest(name, [...this.components.keys()])}`);
    return c;
  }

  prefab(name: string): PrefabDoc {
    const p = this.prefabs.get(name);
    if (!p) throw new Error(`プレハブ ${name} はありません${suggest(name, [...this.prefabs.keys()])}`);
    return p;
  }

  /** 既定値で埋めたコンポーネントデータを作る（不正な値は例外） */
  build(name: string, data: Record<string, unknown> = {}, where = ''): Record<string, unknown> {
    const def = this.component(name);
    const errs = checkComponent(def, data);
    if (errs.length) throw new Error(`${where ? where + ': ' : ''}${errs.join(' / ')}`);
    return { ...defaultsOf(def), ...structuredClone(data) };
  }
}
