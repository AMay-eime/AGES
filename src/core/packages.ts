// 追加パッケージ（本体に入っているが、プロジェクトが ages.project.json の packages に書いたときだけ読み込む機能のまとまり。例 3d）。
// 入れていないプロジェクトでは、部品・システム・表・手順・地図の行のどれも出ない（AI が毎回読む量を増やさない）。
// 一覧と読み込みは src/packages/index.ts、中身は src/packages/<名前>/
import type { ComponentDef } from './schema.ts';
import type { SystemDef } from './registry.ts';
import type { TableDef } from './table.ts';

export interface PackageDef {
  /** packages に書く名前（例 3d）。ゲームのコードからは import … from 'ages/<名前>' */
  name: string;
  /** 何ができるか（地図に出る1行） */
  desc: string;
  /** 標準のコンポーネントと同じ扱い（ゲームのコードで同じ名前を定義できない） */
  components?: ComponentDef[];
  /** ゲームのシステムの後、本体の標準のシステムの前に動く */
  systems?: SystemDef[];
  tables?: TableDef[];
  /** 地図に出す機能の目次（AGENTS.md の目次と同じ書き方。1行ずつ。「→ `項目`」は ages schema guide:項目 で引く） */
  toc?: string[];
}

export function definePackage<T extends PackageDef>(def: T): T {
  return def;
}
