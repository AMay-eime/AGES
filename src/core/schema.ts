// コンポーネントの宣言（型・範囲・既定値・説明）。
// インスペクタの自動生成と、AI・人の入力値の検証の両方がここを使う。
import { EASE_NAMES } from './ease.ts';

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
  /** スプライトシートのコマ。番号（0から）か名前。名前で指定すると、切り直してもずれない */
  | { type: 'frame'; default: number | string; desc?: string }
  /** 表の行の ID（例: 敵の種類）。表にない ID は検証で止まる */
  | { type: 'row'; table: string; default: string; desc?: string }
  /** シーンの名前（ctx.scene.goto の行き先など）。名前を変えると直る */
  | { type: 'scene'; default: string; desc?: string }
  /** 変わり方（イージング。トゥイーンの手触り）。エディタでは曲線で見える */
  | { type: 'ease'; default: string; desc?: string }
  /** 入力のボタンの名前（KeyZ, Pad.A, Mouse0 …）。analog なら軸の名前（Pad.LX …）。エディタでは押して決められる */
  | { type: 'input'; default: string; analog?: boolean; desc?: string }
  /** シェーダーの調整できる値（同じコンポーネントの of の欄で選んだシェーダーの uniform）。中は 住所.params.名前 で指す */
  | { type: 'params'; of: string; default?: Record<string, unknown>; desc?: string }
  | MatrixField
  | ListField
  | StructField
  | OneOfField;

/** 型の名前の一覧（エディタ拡張の欄の見せ方で、型で選ぶときの名前） */
export const FIELD_TYPES = ['number', 'int', 'bool', 'string', 'enum', 'color', 'vec2', 'ref', 'prefab', 'asset', 'frame', 'row', 'scene', 'ease', 'input', 'params', 'matrix', 'list', 'struct', 'oneOf'] as const satisfies readonly Field['type'][];

/** リスト（同じ型の値の並び）。min / max は長さ */
export interface ListField {
  type: 'list';
  of: Field;
  default?: unknown[];
  min?: number;
  max?: number;
  desc?: string;
}

/** 構造体（名前の決まった値の組） */
export interface StructField {
  type: 'struct';
  fields: Record<string, Field>;
  default?: Record<string, unknown>;
  desc?: string;
}

/**
 * どれか1つ（種類によって中身が変わる値）。値は { kind: '種類', ...その種類の値 }。
 * 例: 敵の行動 = move{dx,dy} | wait{frames} | shoot{pattern}。リストにすれば命令の列になる
 */
export interface OneOfField {
  type: 'oneOf';
  variants: Record<string, { desc?: string; fields: Record<string, Field> }>;
  default?: Record<string, unknown>;
  desc?: string;
}

/** 値の既定値（リスト・構造体・どれか1つは中から作る）。毎回新しい値を返す */
export function defaultOf(f: Field): unknown {
  if (f.default !== undefined) return typeof f.default === 'object' && f.default !== null ? structuredClone(f.default) : f.default;
  switch (f.type) {
    case 'list': return [];
    case 'struct': return Object.fromEntries(Object.entries(f.fields).map(([k, sf]) => [k, defaultOf(sf)]));
    case 'oneOf': {
      const [kind, v] = Object.entries(f.variants)[0] ?? ['', { fields: {} }];
      return variantDefault(kind, v.fields);
    }
    case 'params': return {};
    default: return undefined;
  }
}

export function variantDefault(kind: string, fields: Record<string, Field>): Record<string, unknown> {
  return { kind, ...Object.fromEntries(Object.entries(fields).map(([k, sf]) => [k, defaultOf(sf)])) };
}

/** 入れ子の値の中の、ある場所の型（リストは要素、構造体・どれか1つはその項目）。value はその場所までの実際の値 */
export function fieldAt(f: Field, sub: (string | number)[], value: unknown): Field | null {
  let cur: Field = f, v: unknown = value;
  for (const seg of sub) {
    if (cur.type === 'list' && typeof seg === 'number') { cur = cur.of; v = Array.isArray(v) ? v[seg] : undefined; continue; }
    if (cur.type === 'struct' && typeof seg === 'string' && cur.fields[seg]) { v = (v as Record<string, unknown> | undefined)?.[seg]; cur = cur.fields[seg]; continue; }
    if (cur.type === 'oneOf' && typeof seg === 'string') {
      const kind = (v as { kind?: string } | undefined)?.kind ?? Object.keys(cur.variants)[0];
      if (seg === 'kind') return { type: 'enum', options: Object.keys(cur.variants), default: kind };
      const sf = cur.variants[kind]?.fields[seg];
      if (!sf) return null;
      v = (v as Record<string, unknown> | undefined)?.[seg];
      cur = sf;
      continue;
    }
    return null;
  }
  return cur;
}

export type AssetKind = 'image' | 'sound' | 'font' | 'shader';

/** 種類ごとの拡張子 */
export const ASSET_EXT: Record<AssetKind, string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  sound: ['.wav', '.mp3', '.ogg', '.m4a'],
  font: ['.ttf', '.otf', '.woff', '.woff2'],
  shader: ['.frag', '.glsl'],
};

/** 種類の名前（人に見せる） */
export const ASSET_LABEL: Record<AssetKind, string> = { image: '画像', sound: '音', font: 'フォント', shader: 'シェーダー' };

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
    out[k] = defaultOf(f);
  }
  return out;
}

/** 1つの値を検証する。問題なければ null、あればヒント付きの日本語メッセージ。 */
export function checkValue(comp: string, key: string, f: Field, v: unknown): string | null {
  return checkAt(`${comp}.${key}`, f, v);
}

/** 場所（at）を付けて値を検証する。リスト・構造体・どれか1つは中まで見て、問題のある場所を正確に示す */
export function checkAt(at: string, f: Field, v: unknown): string | null {
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
      if (f.kind === 'shader' && v.startsWith('std:')) return null; // 標準のシェーダー（あるかどうかはプロジェクトの検証で見る）
      if (v.startsWith('/') || v.includes('..')) return `${at} はプロジェクトの中の場所で書いてください（例: assets/ship.png）。受け取った値: ${v}`;
      const ok = ASSET_EXT[f.kind].some((e) => v.toLowerCase().endsWith(e));
      return ok ? null : `${at} は${ASSET_LABEL[f.kind]}のファイル（${ASSET_EXT[f.kind].join(' ')}${f.kind === 'shader' ? '、または標準の std:名前' : ''}）が必要です。受け取った値: ${v}`;
    }
    case 'frame':
      if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? null : `${at} はコマの番号（0以上の整数）か名前が必要です。受け取った値: ${v}`;
      return typeof v === 'string' && v !== '' ? null : `${at} はコマの番号（0以上の整数）か名前が必要です。受け取った値: ${JSON.stringify(v)}`;
    case 'row':
      return typeof v === 'string' ? null : `${at} は表 ${f.table} の行の ID（文字列）が必要です`;
    case 'scene':
      return typeof v === 'string' ? null : `${at} はシーンの名前（文字列）が必要です`;
    case 'ease':
      return typeof v === 'string' && (EASE_NAMES as string[]).includes(v) ? null : `${at}=${JSON.stringify(v)} は変わり方の名前ではありません${suggest(String(v), EASE_NAMES)}（ある名前: ${EASE_NAMES.join(' ')}）`;
    case 'input':
      return typeof v === 'string' ? null : `${at} は${f.analog ? '軸' : 'ボタン'}の名前（例 ${f.analog ? 'Pad.LX' : 'KeyZ, Pad.A, Mouse0'}）が必要です`;
    case 'matrix':
      return checkMatrix(at, f, v);
    case 'list': {
      if (!Array.isArray(v)) return `${at} はリスト（[...]）が必要です。受け取った値: ${short(v)}`;
      if (f.min !== undefined && v.length < f.min) return `${at} は ${f.min} 個以上が必要です（${v.length} 個）`;
      if (f.max !== undefined && v.length > f.max) return `${at} は ${f.max} 個までです（${v.length} 個）`;
      for (let i = 0; i < v.length; i++) {
        const e = checkAt(`${at}[${i}]`, f.of, v[i]);
        if (e) return e;
      }
      return null;
    }
    case 'struct': return checkFields(at, f.fields, v);
    case 'params': {
      // 名前と型は、選んだシェーダーと照らしてプロジェクトの検証で見る。ここでは形だけ
      if (!v || typeof v !== 'object' || Array.isArray(v)) return `${at} は { 名前: 値 } の形が必要です（${f.of} で選んだシェーダーの uniform）。受け取った値: ${short(v)}`;
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const ok = typeof x === 'number' || typeof x === 'boolean' || typeof x === 'string' || (Array.isArray(x) && x.every((n) => typeof n === 'number'));
        if (!ok) return `${at}.${k} は数・true/false・色・[x, y] のどれかです。受け取った値: ${short(x)}`;
      }
      return null;
    }
    case 'oneOf': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return `${at} は { kind: 種類, ... } が必要です（種類: ${Object.keys(f.variants).join(' | ')}）`;
      const kind = (v as { kind?: unknown }).kind;
      const kinds = Object.keys(f.variants);
      if (typeof kind !== 'string' || !f.variants[kind]) return `${at}.kind=${JSON.stringify(kind)} は ${kinds.join(' | ')} のどれかです${suggest(String(kind), kinds)}`;
      const { kind: _k, ...rest } = v as Record<string, unknown>;
      return checkFields(`${at}(${kind})`, f.variants[kind].fields, rest);
    }
  }
}

function checkFields(at: string, fields: Record<string, Field>, v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return `${at} は { ${Object.keys(fields).join(', ')} } の形の値が必要です。受け取った値: ${short(v)}`;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const sf = fields[k];
    if (!sf) return `${at} に ${k} という項目はありません${suggest(k, Object.keys(fields))}（ある項目: ${Object.keys(fields).join(', ') || 'なし'}）`;
    const e = checkAt(`${at}.${k}`, sf, x);
    if (e) return e;
  }
  return null;
}

const short = (v: unknown) => { const s = JSON.stringify(v) ?? String(v); return s.length > 40 ? s.slice(0, 37) + '...' : s; };

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

/** 型だけの短い表記（入れ子の中で使う）。例: "list<{at:int,enemy:row<enemies>}>" */
export function typeOf(f: Field): string {
  const r = (min?: number, max?: number) => (min !== undefined || max !== undefined ? ` ${min ?? ''}..${max ?? ''}` : '');
  switch (f.type) {
    case 'number': return `num${r(f.min, f.max)}`;
    case 'int': return `int${r(f.min, f.max)}`;
    case 'enum': return f.options.join('|');
    case 'asset': return `asset<${f.kind}>`;
    case 'row': return `row<${f.table}>`;
    case 'scene': return 'scene';
    case 'ease': return 'ease';
    case 'params': return `params<${f.of}>`;
    case 'input': return f.analog ? 'axis' : 'button';
    case 'matrix': return `matrix<${f.cell ?? 'number'}${r(f.min, f.max)}>`;
    case 'list': return `list<${typeOf(f.of)}>${f.min !== undefined || f.max !== undefined ? `(${f.min ?? 0}..${f.max ?? ''}個)` : ''}`;
    case 'struct': return `{${Object.entries(f.fields).map(([k, sf]) => `${k}:${typeOf(sf)}`).join(',')}}`;
    case 'oneOf': return `oneOf<${Object.entries(f.variants).map(([k, v]) => `${k}{${Object.entries(v.fields).map(([fk, sf]) => `${fk}:${typeOf(sf)}`).join(',')}}`).join('|')}>`;
    default: return f.type;
  }
}

/** AI向けの短い型表記。例: "num 0..20=4" */
export function brief(f: Field): string {
  switch (f.type) {
    case 'vec2': return `vec2=${JSON.stringify(f.default)}`;
    case 'frame': return `frame(番号か名前)=${JSON.stringify(f.default)}`;
    case 'matrix': {
      const size = f.rows !== undefined || f.cols !== undefined ? ` ${f.rows ?? '?'}x${f.cols ?? '?'}固定` : '';
      return `${typeOf(f)}${size}=${matrixSize(f.default)}`;
    }
    case 'list': return `${typeOf(f)}=${JSON.stringify(defaultOf(f))}`;
    case 'struct': case 'oneOf': return typeOf(f);
    case 'params': return `params（${f.of} のシェーダーの値）`;
    case 'number': case 'int': case 'enum': case 'asset': case 'row': case 'scene': case 'ease': return `${typeOf(f)}=${typeof f.default === 'string' ? JSON.stringify(f.default) : f.default}`;
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

/**
 * 値の中の葉（リスト・構造体・どれか1つの中まで）を順に見る。参照（プレハブ・表の行・ファイル・コマ）の検証に使う。
 * cb には、その葉の型・値・場所（例 "Spawner.waves[2].enemy"）が渡る
 */
export function visit(f: Field, v: unknown, at: string, cb: (f: Field, v: unknown, at: string) => void): void {
  if (f.type === 'list') { if (Array.isArray(v)) v.forEach((x, i) => visit(f.of, x, `${at}[${i}]`, cb)); return; }
  if (f.type === 'struct') {
    if (v && typeof v === 'object') for (const [k, sf] of Object.entries(f.fields)) if (k in (v as object)) visit(sf, (v as Record<string, unknown>)[k], `${at}.${k}`, cb);
    return;
  }
  if (f.type === 'oneOf') {
    const kind = (v as { kind?: string } | null)?.kind;
    const vf = kind ? f.variants[kind]?.fields : undefined;
    if (vf && v && typeof v === 'object') for (const [k, sf] of Object.entries(vf)) if (k in (v as object)) visit(sf, (v as Record<string, unknown>)[k], `${at}.${k}`, cb);
    return;
  }
  cb(f, v, at);
}

/** 値の中の葉を置き換えた新しい値（fn が undefined を返した葉はそのまま）。表の行の ID の付け替えなどに使う */
export function mapLeaves(f: Field, v: unknown, fn: (f: Field, v: unknown) => unknown): unknown {
  if (f.type === 'list') return Array.isArray(v) ? v.map((x) => mapLeaves(f.of, x, fn)) : v;
  if (f.type === 'struct' || f.type === 'oneOf') {
    if (!v || typeof v !== 'object') return v;
    const fields = f.type === 'struct' ? f.fields : f.variants[(v as { kind?: string }).kind ?? '']?.fields ?? {};
    const out: Record<string, unknown> = { ...(v as Record<string, unknown>) };
    for (const [k, sf] of Object.entries(fields)) if (k in out) out[k] = mapLeaves(sf, out[k], fn);
    return out;
  }
  const r = fn(f, v);
  return r === undefined ? v : r;
}

/** 省いた項目を既定値で埋めた値（構造体・どれか1つ・その並び）。見せるとき用 */
export function filled(f: Field, v: unknown): unknown {
  if (f.type === 'list') return Array.isArray(v) ? v.map((x) => filled(f.of, x)) : v;
  if (f.type === 'struct') {
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(f.fields).map(([k, sf]) => [k, k in (v as object) ? filled(sf, (v as Record<string, unknown>)[k]) : defaultOf(sf)]));
  }
  if (f.type === 'oneOf') {
    if (!v || typeof v !== 'object') return v;
    const kind = (v as { kind?: string }).kind ?? '';
    const vf = f.variants[kind]?.fields;
    if (!vf) return v;
    return { kind, ...Object.fromEntries(Object.entries(vf).map(([k, sf]) => [k, k in (v as object) ? filled(sf, (v as Record<string, unknown>)[k]) : defaultOf(sf)])) };
  }
  return v;
}
