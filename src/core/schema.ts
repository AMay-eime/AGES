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
  | { type: 'prefab'; default: string; desc?: string };

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
    out[k] = Array.isArray(f.default) ? [...f.default] : f.default;
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
  }
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
