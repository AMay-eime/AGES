// コンポーネント・システム・プレハブの登録簿。
import { checkAt, checkComponent, defaultOf, defaultsOf, suggest, type ComponentDef, type StructField } from './schema.ts';
import { paramDefaults, paramsField, shaderMap, type ShaderDef } from './shader.ts';
import type { Row, TableDef, TableDoc, TableView } from './table.ts';
import type { PrefabDoc, SceneDoc } from './docs.ts';
import type { SheetDef } from './sheet.ts';
import { STD_COMPONENTS } from '../std/components.ts';
import { STD_SYSTEMS } from '../std/systems.ts';
import { STD_TABLES, textTable } from '../std/tables.ts';
import { resolvePrefab } from './variant.ts';
import type { Ctx } from './game.ts';

export interface SystemDef {
  name: string;
  /** 何をするシステムか（地図に載る一行説明） */
  desc: string;
  /** 読むコンポーネント（依存関係の検索に使う） */
  reads?: string[];
  /** 書き換えるコンポーネント */
  writes?: string[];
  /** シーンに入ったときに1回（最初のシーンにも、goto で入ったシーンにも） */
  start?(ctx: Ctx): void;
  /** 毎フレーム（出来事を受けるだけのシステムなら省ける） */
  update?(ctx: Ctx): void;
  /**
   * 出来事を受ける。ctx.emit のときに、その場で呼ばれる（このシーンで動くシステムだけ、実行順に）。
   * 例 on: { enemyKilled(ctx, data) { ... } }。標準の出来事: scene（{ from, to }）、ui.click（{ id }）
   */
  on?: Record<string, (ctx: Ctx, data: any) => void>;
  /** シーンを出るときに1回（goto の切り替えの直前。物はまだ残っている） */
  exit?(ctx: Ctx): void;
  /** このシーンでだけ動く（省くと全部のシーンで）。例 ['title'] */
  scenes?: string[];
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
  /** シーン（名前 → 中身）。ctx.scene.goto で切り替える先 */
  scenes = new Map<string, SceneDoc>();
  /** スプライトシート（定義ファイルの場所 → 中身） */
  sheets = new Map<string, SheetDef>();
  /** 表の形 */
  tables = new Map<string, TableDef>();
  /** 表の中身（名前 → 行の並び） */
  tableData = new Map<string, TableDoc>();
  private views = new WeakMap<TableDoc, TableView>();
  /** シェーダー（場所 → 宣言）。標準の std:名前 も入っている */
  shaders: Map<string, ShaderDef> = shaderMap();
  /** 画像の大きさ（場所 → 幅・高さ）。格子のシートのコマを求めるのに使う */
  images = new Map<string, { w: number; h: number }>();
  /** 標準のコンポーネントの名前 */
  readonly std = new Set(STD_COMPONENTS.map((c) => c.name));
  /** 標準の表の名前 */
  readonly stdTables = new Set(STD_TABLES.map((t) => t.name));

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
      if (s.on !== undefined) {
        if (!s.on || typeof s.on !== 'object') throw new Error(`システム ${s.name}: on は { 出来事の名前: (ctx, data) => { ... } } で書きます`);
        for (const [ev, fn] of Object.entries(s.on)) if (typeof fn !== 'function') throw new Error(`システム ${s.name}: on.${ev} が関数ではありません（(ctx, data) => { ... } で書きます）`);
      }
      if (!s.update && !s.on && !s.start && !s.exit) throw new Error(`システム ${s.name} に update・on・start・exit のどれもありません`);
      for (const c of [...(s.reads ?? []), ...(s.writes ?? [])]) {
        if (!r.components.has(c)) throw new Error(`システム ${s.name} が未定義のコンポーネント ${c} を参照しています${suggest(c, [...r.components.keys()])}`);
      }
      r.systems.push(s);
    }
    for (const t of STD_TABLES) r.tables.set(t.name, t);
    for (const t of mod.tables ?? []) {
      if (STD_TABLES.some((x) => x.name === t.name)) throw new Error(`表 ${t.name} は標準で用意されています。game/ の定義を消して、標準のものを使ってください（ages schema <dir> $${t.name}）`);
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

  /** 言葉の表 $text の列（言語）を決める。同じなら何もしない */
  setLanguages(languages: string[]): void {
    const cur = Object.keys(this.tables.get('text')?.columns ?? {}).filter((k) => k !== 'desc');
    if (cur.join(',') === languages.join(',')) return;
    this.tables.set('text', textTable(languages));
    this.views = new WeakMap();
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

  /** 使うときのプレハブ（派生なら元と重ねたもの） */
  prefab(name: string): PrefabDoc {
    return resolvePrefab(this.prefabs, name);
  }

  /** あれば使うときのプレハブ（ない・元が見つからなければ undefined） */
  findPrefab(name: string): PrefabDoc | undefined {
    try { return this.prefabs.has(name) ? resolvePrefab(this.prefabs, name) : undefined; } catch { return undefined; }
  }

  /** すべてのプレハブを使うときの形で（元が見つからない派生はそのまま。検証で知らせる） */
  allPrefabs(): PrefabDoc[] {
    return [...this.prefabs.keys()].map((n) => { try { return resolvePrefab(this.prefabs, n); } catch { return this.prefabs.get(n)!; } });
  }

  /** 既定値で埋めたコンポーネントデータを作る（不正な値は例外） */
  build(name: string, data: Record<string, unknown> = {}, where = ''): Record<string, unknown> {
    const def = this.component(name);
    const errs = checkComponent(def, data);
    const out = { ...defaultsOf(def), ...structuredClone(data) };
    // シェーダーの値: 選んだシェーダーの uniform と照らし、省いたものは既定値で埋める
    for (const [k, f] of Object.entries(def.fields)) {
      if (f.type !== 'params') continue;
      const sh = this.shaders.get(String(out[f.of] ?? ''));
      if (!sh) continue;
      const e = checkAt(`${name}.${k}`, paramsField(sh), out[k] ?? {});
      if (e) errs.push(e);
      out[k] = { ...paramDefaults(sh), ...(out[k] as object) };
    }
    if (errs.length) throw new Error(`${where ? where + ': ' : ''}${errs.join(' / ')}`);
    return out;
  }

  /** シェーダーの調整できる値の型（シェーダーが見つからなければ null） */
  shaderParams(path: unknown): StructField | null {
    const sh = typeof path === 'string' ? this.shaders.get(path) : undefined;
    return sh ? paramsField(sh) : null;
  }
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}
