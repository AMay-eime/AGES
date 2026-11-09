// プレハブの派生（元を受け継いで一部だけ変える。Unity の Prefab Variant にあたる）と、シーンに置いたプレハブのインスタンス。
// ファイル（と編集の正本）には「元の名前（base）・変えた値・外した部品（remove）」だけを書き、使うときに元と重ねる。
// 重ね方はフィールドごと: 派生が書いたフィールドはその値、書いていないフィールドは元の値（リスト・構造体は丸ごと）。
import type { EntityData, PrefabDoc, SceneDoc } from './docs.ts';
import { suggest } from './schema.ts';

export const isVariant = (p: PrefabDoc | undefined): boolean => !!p?.base;

/** 元をたどった並び（自分 → 元 → 元の元 …）。ない元・輪は例外 */
export function baseChain(prefabs: Map<string, PrefabDoc>, name: string): PrefabDoc[] {
  const out: PrefabDoc[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = name;
  while (cur) {
    if (seen.has(cur)) throw new Error(`@${name}: 派生の元が輪になっています（${[...seen, cur].map((n) => '@' + n).join(' ← ')}）`);
    seen.add(cur);
    const p = prefabs.get(cur);
    if (!p) throw new Error(cur === name ? `プレハブ ${name} はありません${suggest(name, [...prefabs.keys()])}` : `@${out[out.length - 1].name} の元 @${cur} がありません${suggest(cur, [...prefabs.keys()])}`);
    out.push(p);
    cur = p.base;
  }
  return out;
}

/** 元と重ねた、使うときの中身（派生でなければそのまま返す）。base・remove は付けない */
export function resolvePrefab(prefabs: Map<string, PrefabDoc>, name: string): PrefabDoc {
  const p = prefabs.get(name);
  if (!p) throw new Error(`プレハブ ${name} はありません${suggest(name, [...prefabs.keys()])}`);
  if (!p.base) return p;
  const chain = baseChain(prefabs, name).reverse();
  let comps: Record<string, Record<string, unknown>> = {};
  let tags: string[] | undefined;
  let desc: string | undefined;
  for (const d of chain) {
    const next: Record<string, Record<string, unknown>> = {};
    for (const [c, v] of Object.entries(comps)) if (!d.remove?.includes(c)) next[c] = v;
    for (const [c, v] of Object.entries(d.components ?? {})) next[c] = { ...(next[c] ?? {}), ...v };
    comps = next;
    if (d.tags) tags = d.tags;
    if (d.desc) desc = d.desc;
  }
  return { name: p.name, ...(desc ? { desc } : {}), ...(tags ? { tags } : {}), components: structuredClone(comps) };
}

/** 派生が元から変えている所（地図・インスペクタ用）: フィールドは "部品.名前"、足した部品は "+部品"、外した部品は "-部品" */
export function overridesOf(prefabs: Map<string, PrefabDoc>, name: string): string[] {
  const p = prefabs.get(name);
  if (!p?.base) return [];
  let base: PrefabDoc | undefined;
  try { base = resolvePrefab(prefabs, p.base); } catch { /* 元がない: 検証で知らせる */ }
  const out: string[] = [];
  for (const [c, v] of Object.entries(p.components ?? {})) {
    if (base && !base.components[c]) { out.push('+' + c); continue; }
    for (const k of Object.keys(v)) out.push(`${c}.${k}`);
  }
  for (const c of p.remove ?? []) out.push('-' + c);
  if (p.tags) out.push('tags');
  return out;
}

/**
 * シーンの物がプレハブのインスタンス（prefab）なら、プレハブ（派生なら元と重ねたもの）と物が書いた値を重ねた中身。そうでなければそのまま。
 * 重ね方は派生と同じ（フィールドごと。物が書いたフィールドはその値、書いていないフィールドはプレハブの値。remove の部品は外す）。tags は物が書けばそれ
 */
export function resolveEntity(prefabs: Map<string, PrefabDoc>, e: EntityData): EntityData {
  if (!e.prefab) return e;
  let p: PrefabDoc;
  try { p = resolvePrefab(prefabs, e.prefab); } catch (err) { throw new Error(`#${e.id} のプレハブ: ${(err as Error).message}`); }
  const comps: Record<string, Record<string, unknown>> = {};
  for (const [c, v] of Object.entries(p.components)) if (!e.remove?.includes(c)) comps[c] = structuredClone(v);
  for (const [c, v] of Object.entries(e.components ?? {})) comps[c] = { ...(comps[c] ?? {}), ...structuredClone(v) };
  const tags = e.tags ?? p.tags;
  return { id: e.id, name: e.name, prefab: e.prefab, ...(tags ? { tags: [...tags] } : {}), components: comps };
}

/** シーンの物をすべて、プレハブと重ねた中身にしたもの（読むだけ） */
export function resolveScene(prefabs: Map<string, PrefabDoc>, s: SceneDoc): SceneDoc {
  if (!s.entities.some((e) => e.prefab)) return s;
  return { ...s, entities: s.entities.map((e) => resolveEntity(prefabs, e)) };
}

/** インスタンスがプレハブから変えている所（地図・インスペクタ用）: "部品.名前"・足した部品は "+部品"・外した部品は "-部品" */
export function instanceOverrides(prefabs: Map<string, PrefabDoc>, e: EntityData): string[] {
  if (!e.prefab) return [];
  let base: PrefabDoc | undefined;
  try { base = resolvePrefab(prefabs, e.prefab); } catch { /* ないプレハブ: 検証で知らせる */ }
  const out: string[] = [];
  for (const [c, v] of Object.entries(e.components ?? {})) {
    if (base && !base.components[c]) { out.push('+' + c); continue; }
    for (const k of Object.keys(v)) out.push(`${c}.${k}`);
  }
  for (const c of e.remove ?? []) out.push('-' + c);
  if (e.tags) out.push('tags');
  return out;
}

/** プレハブの欄で選べるプレハブの名前（tags を書いた欄は、そのタグのどれかを持つものだけ。派生は元から受け継いだタグで見る） */
export function prefabChoices(prefabs: Map<string, PrefabDoc>, tags?: string[]): string[] {
  const names = [...prefabs.keys()];
  if (!tags?.length) return names;
  return names.filter((n) => {
    let t: string[] | undefined;
    try { t = resolvePrefab(prefabs, n).tags; } catch { t = prefabs.get(n)?.tags; }
    return !!t?.some((x) => tags.includes(x));
  });
}
