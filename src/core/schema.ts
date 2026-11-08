// コンポーネントの宣言（型・範囲・既定値・説明）。
// インスペクタの自動生成と、AI・人の入力値の検証の両方がここを使う。

export type Field =
  | { type: 'number'; default: number; min?: number; max?: number; step?: number; desc?: string }
  | { type: 'int'; default: number; min?: number; max?: number; desc?: string }
  | { type: 'bool'; default: boolean; desc?: string }
  | { type: 'string'; default: string; desc?: string }
  | { type: 'enum'; default: string; options: string[]; desc?: string }
  | { type: 'color'; default: string; desc?: string }
  | { type: 'vec2'; default: [number, number]; desc?: string }
  | { type: 'ref'; default: string | null; desc?: string }
  | { type: 'prefab'; default: string; desc?: string }
  /** プロジェクトの中のファイル（例: assets/ships.png）。kind で種類を絞る。空文字はなし */
  | { type: 'asset'; kind: AssetKind; default: string; desc?: string }
  | MatrixField;

export type AssetKind = 'image' | 'sound' | 'font';

/** 種類ごとの拡張子 */
export const ASSET_EXT: Record<AssetKind, string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  sound: ['.wav', '.mp3', '.ogg', '.m4a'],
  font: ['.ttf', '.otf', '.woff', '.woff2'],
};

/** 2次元行列（例: 敵の出現パターン、地形、ダメージ表）。インスペクタでは「開く」から専用の行列エディタで編集する。 */
export interface MatrixField {
  type: 'matrix';
  /** 行の配列。各行は同じ長さ */
  default: (number | boolean | string)[][];
  /** セルの型（既定 number） */
  cell?: 'number' | 'int' | 'bool' | 'string';
  /** 数値セルの範囲 */
  min?: number;
  max?: number;
  /** 行数・列数を固定する場合 */
  rows?: number;
  cols?: number;
  desc?: string;
}

export type CellValue = number | boolean | string;

export interface ComponentDef {
  name: string;
  desc: string;
  fields: Record<string, Field>;
}

export function defineComponent<T extends ComponentDef>(def: T): T {
  return def;
}

export function defaultsOf(def: ComponentDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(def.fields)) {
    out[k] = typeof f.default === 'object' && f.default !== null ? structuredClone(f.default) : f.default;
  }
  return out;
}

/** 1つの値を検証する。問題なければ null、あればヒント付きの日本語メッセージ。 */
export function checkValue(comp: string, key: string, f: Field, v: unknown): string | null {
  const at = `${comp}.${key}`;
  const range = (min?: number, max?: number) =>
    min !== undefined || max !== undefined ? `（範囲 ${min ?? '-∞'}..${max ?? '∞'}）` : '';
  switch (f.type) {
    case 'number':
    case 'int': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${at} は数値が必要です${range(f.min, f.max)}。受け取った値: ${JSON.stringify(v)}`;
      if (f.type === 'int' && !Number.isInteger(v)) return `${at} は整数が必要です。受け取った値: ${v}`;
      if (f.min !== undefined && v < f.min) return `${at}=${v} は最小値 ${f.min} 未満です${range(f.min, f.max)}`;
      if (f.max !== undefined && v > f.max) return `${at}=${v} は最大値 ${f.max} を超えています${range(f.min, f.max)}`;
      return null;
    }
    case 'bool':
      return typeof v === 'boolean' ? null : `${at} は true/false が必要です。受け取った値: ${JSON.stringify(v)}`;
    case 'string':
      return typeof v === 'string' ? null : `${at} は文字列が必要です`;
    case 'enum':
      return typeof v === 'string' && f.options.includes(v)
        ? null
        : `${at} は ${f.options.join(' | ')} のどれかです。受け取った値: ${JSON.stringify(v)}${suggest(String(v), f.options)}`;
    case 'color':
      return typeof v === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v) ? null : `${at} は #rrggbb 形式の色が必要です。受け取った値: ${JSON.stringify(v)}`;
    case 'vec2':
      return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
        ? null
        : `${at} は [x, y] の数値2つが必要です`;
    case 'ref':
      return v === null || typeof v === 'string' ? null : `${at} はエンティティID（文字列）か null が必要です`;
    case 'prefab':
      return typeof v === 'string' ? null : `${at} はプレハブ名（文字列）が必要です`;
    case 'asset': {
      if (typeof v !== 'string') return `${at} はファイルの場所（文字列。例: assets/ship.png）が必要です`;
      if (v === '') return null;
      if (v.startsWith('/') || v.includes('..')) return `${at} はプロジェクトの中の場所で書いてください（例: assets/ship.png）。受け取った値: ${v}`;
      const ok = ASSET_EXT[f.kind].some((e) => v.toLowerCase().endsWith(e));
      return ok ? null : `${at} は${f.kind === 'image' ? '画像' : f.kind === 'sound' ? '音' : 'フォント'}のファイル（${ASSET_EXT[f.kind].join(' ')}）が必要です。受け取った値: ${v}`;
    }
    case 'matrix':
      return checkMatrix(at, f, v);
  }
}

/** 行列のセル1つを検証する */
export function checkCell(at: string, f: MatrixField, r: number, c: number, v: unknown): string | null {
  const where = `${at}[${r},${c}]`;
  const cell = f.cell ?? 'number';
  if (cell === 'bool') return typeof v === 'boolean' ? null : `${where} は true/false が必要です。受け取った値: ${JSON.stringify(v)}`;
  if (cell === 'string') return typeof v === 'string' ? null : `${where} は文字列が必要です`;
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${where} は数値が必要です。受け取った値: ${JSON.stringify(v)}`;
  if (cell === 'int' && !Number.isInteger(v)) return `${where} は整数が必要です。受け取った値: ${v}`;
  const range = f.min !== undefined || f.max !== undefined ? `（範囲 ${f.min ?? '-∞'}..${f.max ?? '∞'}）` : '';
  if (f.min !== undefined && v < f.min) return `${where}=${v} は最小値 ${f.min} 未満です${range}`;
  if (f.max !== undefined && v > f.max) return `${where}=${v} は最大値 ${f.max} を超えています${range}`;
  return null;
}

function checkMatrix(at: string, f: MatrixField, v: unknown): string | null {
  if (!Array.isArray(v) || !v.every((row) => Array.isArray(row))) return `${at} は行列（配列の配列）が必要です。例: [[0,1],[1,0]]`;
  const m = v as unknown[][];
  if (f.rows !== undefined && m.length !== f.rows) return `${at} は ${f.rows} 行が必要です（受け取ったのは ${m.length} 行）`;
  const cols = m[0]?.length ?? 0;
  for (let r = 0; r < m.length; r++) {
    if (m[r].length !== cols) return `${at} の ${r} 行目の長さが ${m[r].length} です。すべての行を ${cols} 列にそろえてください`;
  }
  if (f.cols !== undefined && m.length && cols !== f.cols) return `${at} は ${f.cols} 列が必要です（受け取ったのは ${cols} 列）`;
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < cols; c++) {
      const e = checkCell(at, f, r, c, m[r][c]);
      if (e) return e;
    }
  }
  return null;
}

/** 行列の大きさ "行x列" */
export function matrixSize(v: unknown): string {
  const m = Array.isArray(v) ? (v as unknown[][]) : [];
  return `${m.length}x${m[0]?.length ?? 0}`;
}

/** コンポーネントのデータ全体を検証する。 */
export function checkComponent(def: ComponentDef, data: Record<string, unknown>): string[] {
  const errs: string[] = [];
  for (const key of Object.keys(data)) {
    const f = def.fields[key];
    if (!f) {
      errs.push(`${def.name} に ${key} というフィールドはありません${suggest(key, Object.keys(def.fields))}`);
      continue;
    }
    const e = checkValue(def.name, key, f, data[key]);
    if (e) errs.push(e);
  }
  return errs;
}

/** AI向けの短い型表記。例: "num 0..20=4" */
export function brief(f: Field): string {
  const r = (min?: number, max?: number) => (min !== undefined || max !== undefined ? ` ${min ?? ''}..${max ?? ''}` : '');
  switch (f.type) {
    case 'number': return `num${r(f.min, f.max)}=${f.default}`;
    case 'int': return `int${r(f.min, f.max)}=${f.default}`;
    case 'enum': return `${f.options.join('|')}=${f.default}`;
    case 'vec2': return `vec2=${JSON.stringify(f.default)}`;
    case 'asset': return `asset<${f.kind}>=${JSON.stringify(f.default)}`;
    case 'matrix': {
      const size = f.rows !== undefined || f.cols !== undefined ? ` ${f.rows ?? '?'}x${f.cols ?? '?'}固定` : '';
      return `matrix<${f.cell ?? 'number'}${r(f.min, f.max)}>${size}=${matrixSize(f.default)}`;
    }
    default: return `${f.type}=${JSON.stringify(f.default)}`;
  }
}

/** 「もしかして」候補。近い名前があれば " もしかして: X" を返す。 */
export function suggest(word: string, candidates: string[]): string {
  let best = '';
  let bestD = Infinity;
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return best && bestD <= Math.max(2, Math.floor(word.length / 3)) ? `。もしかして: ${best}` : '';
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
