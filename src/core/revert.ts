// 元に戻す: ある編集の「前」と「後」から、今の状態をその編集の前に戻す（3つを見比べる）。
// その編集の後に、同じ所が別の値に変えられていたら「ぶつかり」として知らせ、戻さない。
// 物（entities）・表の行（rows）・コマ（frames）は ID（名前）で突き合わせるので、並びが変わっていても戻せる。

export interface RevertResult {
  /** 戻した値（undefined はその値が無い = 消す） */
  value: unknown;
  /** ぶつかった所 */
  conflicts: string[];
}

/** 中身が同じか（オブジェクトのキーの順番は見ない） */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => same(x, bb[i]));
  }
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in (b as object) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** ID で突き合わせられる並びなら、その ID の名前（id か name）。混ざっていれば null */
function keyName(...lists: unknown[][]): 'id' | 'name' | null {
  for (const k of ['id', 'name'] as const) {
    if (lists.every((l) => l.every((x) => isObj(x) && typeof x[k] === 'string'))) {
      if (lists.some((l) => l.length)) return k;
    }
  }
  return null;
}

/**
 * 今の値 current を、ある編集の後 after から前 before へ戻した値。
 * at はぶつかりの知らせに使う場所の名前
 */
export function revert(current: unknown, after: unknown, before: unknown, at: string): RevertResult {
  if (same(current, after)) return { value: structuredClone(before), conflicts: [] };
  if (same(after, before) || same(current, before)) return { value: current, conflicts: [] };
  if (isObj(current) && isObj(after) && isObj(before)) {
    const out: Record<string, unknown> = {};
    const conflicts: string[] = [];
    for (const k of new Set([...Object.keys(current), ...Object.keys(after), ...Object.keys(before)])) {
      const r = revert(current[k], after[k], before[k], label(at, k));
      conflicts.push(...r.conflicts);
      if (r.value !== undefined) out[k] = r.value;
    }
    return { value: out, conflicts };
  }
  if (Array.isArray(current) && Array.isArray(after) && Array.isArray(before)) {
    const key = keyName(current, after, before);
    if (key) return revertKeyed(current, after, before, key, at);
  }
  return { value: current, conflicts: [`${at}（${short(after)} にした後で ${short(current)} に変わっています）`] };
}

function revertKeyed(current: unknown[], after: unknown[], before: unknown[], key: 'id' | 'name', at: string): RevertResult {
  const idOf = (x: unknown) => (x as Record<string, string>)[key];
  const A = new Map(after.map((x) => [idOf(x), x])), B = new Map(before.map((x) => [idOf(x), x])), C = new Map(current.map((x) => [idOf(x), x]));
  const conflicts: string[] = [];
  const result = new Map<string, unknown>();
  for (const k of new Set([...C.keys(), ...A.keys(), ...B.keys()])) {
    if (C.has(k) && !A.has(k) && !B.has(k)) { result.set(k, C.get(k)); continue; } // 後から足されたもの
    const r = revert(C.get(k), A.get(k), B.get(k), keyLabel(at, k));
    conflicts.push(...r.conflicts);
    if (r.value !== undefined) result.set(k, r.value);
  }
  // 並び: 今の並びがその編集の後のままなら、編集の前の並びに戻す。違っていれば今の並びを保ち、戻したものは前の場所に入れる
  const ids = (l: unknown[]) => l.map(idOf).filter((k) => result.has(k));
  const order = ids(current).join('\u0000') === ids(after).join('\u0000')
    ? [...ids(before), ...[...result.keys()].filter((k) => !B.has(k))]
    : (() => {
      const list = ids(current);
      before.forEach((x, i) => { const k = idOf(x); if (result.has(k) && !list.includes(k)) list.splice(Math.min(i, list.length), 0, k); });
      return list;
    })();
  return { value: [...new Set(order)].filter((k) => result.has(k)).map((k) => result.get(k)), conflicts };
}

const label = (at: string, k: string) => (k === 'components' || k === 'entities' || k === 'rows' || k === 'frames' ? at : `${at}.${k}`);
const keyLabel = (at: string, k: string) => (/^scene:/.test(at) && !at.includes('#') ? `${at.slice(6)}#${k}` : `${at}.${k}`);
const short = (v: unknown) => { const s = v === undefined ? '（なし）' : JSON.stringify(v); return s.length > 30 ? s.slice(0, 27) + '…' : s; };
