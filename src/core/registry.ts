// コンポーネント・システム・プレハブの登録簿。
import { checkComponent, defaultOf, defaultsOf, suggest, type ComponentDef } from './schema.ts';
import type { Row, TableDef, TableDoc, TableView } from './table.ts';
import type { PrefabDoc } from './docs.ts';
import type { SheetDef } from './sheet.ts';
import { STD_COMPONENTS } from '../std/components.ts';
import { STD_SYSTEMS } from '../std/systems.ts';
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
  /** 表の形（defineTable）。中身は data/<名前>.table.json */
  tables?: TableDef[];
}

export class Registry {
  components = new Map<string, ComponentDef>();
  systems: SystemDef[] = [];
  prefabs = new Map<string, PrefabDoc>();
  /** スプライトシート（定義ファイルの場所 → 中身） */
  sheets = new Map<string, SheetDef>();
  /** 表の形 */
  tables = new Map<string, TableDef>();
  /** 表の中身（名前 → 行の並び） */
  tableData = new Map<string, TableDoc>();
  private views = new WeakMap<TableDoc, TableView>();
  /** 画像の大きさ（場所 → 幅・高さ）。格子のシートのコマを求めるのに使う */
  images = new Map<string, { w: number; h: number }>();
  /** 標準のコンポーネントの名前 */
  readonly std = new Set(STD_COMPONENTS.map((c) => c.name));

  static from(mod: GameModule, prefabs: Iterable<PrefabDoc> = []): Registry {
    const r = new Registry();
    for (const c of STD_COMPONENTS) r.components.set(c.name, c);
    for (const c of mod.components) {
      if (r.std.has(c.name)) throw new Error(`コンポーネント ${c.name} は標準で用意されています。game/ の定義を消して、標準のものを使ってください（ages schema <dir> ${c.name} で中身を確認できます）`);
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
    for (const t of mod.tables ?? []) {
      if (r.tables.has(t.name)) throw new Error(`表 ${t.name} が2回定義されています`);
      if (!/^[A-Za-z0-9_-]+$/.test(t.name)) throw new Error(`表の名前 "${t.name}" には英数字・_・- だけが使えます`);
      if ('id' in t.columns) throw new Error(`表 ${t.name}: 列 id は自動で付くので、columns に書かないでください`);
      r.tables.set(t.name, t);
    }
    // 標準のシステムはゲームのシステムの後に動く
    for (const s of STD_SYSTEMS) r.systems.push(s);
    for (const p of prefabs) r.prefabs.set(p.name, p);
    return r;
  }

  component(name: string): ComponentDef {
    const c = this.components.get(name);
    if (!c) throw new Error(`コンポーネント ${name} はありません${suggest(name, [...this.components.keys()])}`);
    return c;
  }

  table(name: string): TableDef {
    const t = this.tables.get(name);
    if (!t) throw new Error(`表 ${name} はありません${suggest(name, [...this.tables.keys()])}`);
    return t;
  }

  /** ゲームのコードから読む表（省いた列は既定値で埋め、変えられないようにしてある） */
  tableView(name: string): TableView {
    const def = this.table(name);
    const doc = this.tableData.get(name) ?? { name, rows: [] };
    let v = this.views.get(doc);
    if (!v) {
      const rows = doc.rows.map((r) => deepFreeze({ ...Object.fromEntries(Object.entries(def.columns).map(([k, f]) => [k, defaultOf(f)])), ...structuredClone(r) }) as Row);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ids = Object.freeze(rows.map((r) => r.id));
      v = {
        name,
        rows: Object.freeze(rows),
        ids,
        has: (id) => byId.has(id),
        get: (id) => {
          const r = byId.get(id);
          if (!r) throw new Error(`表 ${name} に行 "${id}" はありません${suggest(String(id), [...ids])}`);
          return r;
        },
      };
      this.views.set(doc, v);
    }
    return v;
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

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}
