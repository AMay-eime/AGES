// 表のデータ。同じ形の行がたくさん並ぶデータ（武器・敵・アイテム・カードなど）。
// 形（列）はゲームのコードで defineTable で決め、中身は data/<名前>.table.json に1行1行で置く。
// 行には ID があり、住所は $表.行.列（例 $enemies.basic.hp）。行の ID は並べ替えても変わらないので、ロックや★がずれない。
import type { Field } from './schema.ts';

/** 型の宣言から、値の TypeScript の型を作る（ゲームのコードで表の行を型付きで読むため） */
export type ValueOf<F> =
  F extends { type: 'number' | 'int' } ? number
  : F extends { type: 'bool' } ? boolean
  : F extends { type: 'string' | 'enum' | 'color' | 'asset' | 'prefab' | 'row' } ? string
  : F extends { type: 'ref' } ? string | null
  : F extends { type: 'frame' } ? number | string
  : F extends { type: 'vec2' } ? [number, number]
  : F extends { type: 'vec3' } ? [number, number, number]
  : F extends { type: 'matrix' } ? (number | boolean | string)[][]
  : F extends { type: 'list'; of: infer O } ? ValueOf<O>[]
  : F extends { type: 'struct'; fields: infer S } ? { [K in keyof S]: ValueOf<S[K]> }
  : F extends { type: 'oneOf' } ? { kind: string } & Record<string, unknown>
  : unknown;

export interface TableDef {
  name: string;
  desc?: string;
  /** 列の型（ID の列は自動で付くので書かない） */
  columns: Record<string, Field>;
}

export function defineTable<T extends TableDef>(def: T): T {
  return def;
}

export type Row = { id: string } & Record<string, unknown>;

/** 表の行の型（例: RowOf<typeof enemies>） */
export type RowOf<T extends TableDef> = { id: string } & { [K in keyof T['columns']]: ValueOf<T['columns'][K]> };

export interface TableDoc {
  name: string;
  rows: Row[];
}

export const ROW_ID = /^[A-Za-z0-9_-]+$/;

/** ゲームのコードから使う表（ctx.table('enemies')）。中身は読むだけ（変えるとゲームの結果が毎回変わりうるため） */
export interface TableView<R = Row> {
  readonly name: string;
  /** 行（並び順どおり。省いた列は既定値で埋めてある） */
  readonly rows: readonly R[];
  readonly ids: readonly string[];
  has(id: string): boolean;
  /** 行を ID で引く。ない ID はエラー（もしかして付き） */
  get(id: string): R;
}
