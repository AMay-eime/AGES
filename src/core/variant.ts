// プレハブの派生（元を受け継いで一部だけ変える。Unity の Prefab Variant にあたる）と、シーンに置いたプレハブのインスタンス。
// ファイル（と編集の正本）には「元の名前（base）・変えた値・外した部品（remove）」だけを書き、使うときに元と重ねる。
// 重ね方はフィールドごと: 派生が書いたフィールドはその値、書いていないフィールドは元の値（リスト・構造体は丸ごと）。
import type { EntityData, PrefabChild, PrefabDoc, SceneDoc } from './docs.ts';
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

// ---- 子を持つプレハブ ----

/** 子の名前（ID の一部になるので、住所の区切りの文字は使わない） */
export const CHILD_NAME = /^[A-Za-z0-9_-]+$/;

/** 元・子にしたプレハブと重ねた、使うときの子 */
export interface ResolvedChild {
  name: string;
  /** 子にしたプレハブ（あれば） */
  prefab?: string;
  tags?: string[];
  components: Record<string, Record<string, unknown>>;
  children: ResolvedChild[];
}

/** プレハブ（派生なら元も）のどこかに子があるか（なければ、出すときに子を探さない） */
export function hasChildren(prefabs: Map<string, PrefabDoc>, name: string): boolean {
  for (let p = prefabs.get(name), n = 0; p && n < 64; p = p.base ? prefabs.get(p.base) : undefined, n++) if (p.children?.length) return true;
  return false;
}

/** 子の並び（over）を、元の子の並び（base）に名前で重ねる。値を変えるだけで、足す・消すはしない */
function overlayChildren(base: ResolvedChild[], over: PrefabChild[] | undefined, where: string): ResolvedChild[] {
  if (!over?.length) return base;
  const out = base.map((c) => ({ ...c }));
  for (const o of over) {
    const i = out.findIndex((c) => c.name === o.name);
    if (i < 0) throw new Error(`${where}/${o.name}: 元にない子です（子の足し引きはできず、値を変えるだけ）${suggest(o.name, out.map((c) => c.name))}`);
    if (o.prefab && o.prefab !== out[i].prefab) throw new Error(`${where}/${o.name}: 子にするプレハブは変えられません（元は ${out[i].prefab ? '@' + out[i].prefab : 'プレハブなし'}）`);
    const comps: Record<string, Record<string, unknown>> = {};
    for (const [c, v] of Object.entries(out[i].components)) if (!o.remove?.includes(c)) comps[c] = v;
    for (const [c, v] of Object.entries(o.components ?? {})) comps[c] = { ...(comps[c] ?? {}), ...structuredClone(v) };
    out[i] = { ...out[i], components: comps, children: overlayChildren(out[i].children, o.children, `${where}/${o.name}`) };
  }
  return out;
}

/** 子1つを使うときの形に（子にしたプレハブがあれば、それと重ねる）。stack は輪を見つけるため */
function resolveChild(prefabs: Map<string, PrefabDoc>, node: PrefabChild, where: string, stack: string[]): ResolvedChild {
  const at = `${where}/${node.name}`;
  if (!node.prefab) {
    return { name: node.name, components: structuredClone(node.components ?? {}), children: (node.children ?? []).map((c) => resolveChild(prefabs, c, at, stack)) };
  }
  let ref: PrefabDoc;
  try { ref = resolvePrefab(prefabs, node.prefab); } catch (e) { throw new Error(`${at}: ${(e as Error).message}`); }
  const comps: Record<string, Record<string, unknown>> = {};
  for (const [c, v] of Object.entries(ref.components)) if (!node.remove?.includes(c)) comps[c] = structuredClone(v);
  for (const [c, v] of Object.entries(node.components ?? {})) comps[c] = { ...(comps[c] ?? {}), ...structuredClone(v) };
  const kids = overlayChildren(prefabChildren(prefabs, node.prefab, stack), node.children, at);
  return { name: node.name, prefab: node.prefab, ...(ref.tags ? { tags: [...ref.tags] } : {}), components: comps, children: kids };
}

/**
 * プレハブの子を、元・子にしたプレハブと重ねた木で（子がなければ []）。
 * 輪（子にしたプレハブが自分を含む）・ない子・ないプレハブは例外
 */
export function prefabChildren(prefabs: Map<string, PrefabDoc>, name: string, stack: string[] = []): ResolvedChild[] {
  if (stack.includes(name)) throw new Error(`子にしたプレハブが輪になっています（${[...stack, name].map((n) => '@' + n).join(' → ')}）`);
  if (!hasChildren(prefabs, name)) return [];
  const chain = baseChain(prefabs, name).reverse();
  const next = [...stack, name];
  let kids: ResolvedChild[] = (chain[0].children ?? []).map((c) => resolveChild(prefabs, c, `@${chain[0].name}`, next));
  for (const d of chain.slice(1)) kids = overlayChildren(kids, d.children, `@${d.name}`);
  return kids;
}

/** 子の木を、出す物の並びに（親が先）。ID は 親のID/名前。位置は親から見た値（Transform.parent か Transform3D.parent） */
export function expandChildren(kids: ResolvedChild[], parentId: string, parent3d: boolean): (EntityData & { prefab?: string })[] {
  const out: (EntityData & { prefab?: string })[] = [];
  for (const k of kids) {
    const id = `${parentId}/${k.name}`;
    const comps = structuredClone(k.components);
    const is3d = comps.Transform3D ? true : comps.Transform ? false : parent3d;
    const key = is3d ? 'Transform3D' : 'Transform';
    comps[key] = { ...(comps[key] ?? {}), parent: parentId };
    out.push({ id, name: k.name, ...(k.prefab ? { prefab: k.prefab } : {}), ...(k.tags ? { tags: [...k.tags] } : {}), components: comps });
    out.push(...expandChildren(k.children, id, is3d));
  }
  return out;
}

/** 子の住所（親/子/孫）で、使うときの子を探す（ない名前は例外） */
export function childAt(kids: ResolvedChild[], path: string[], where: string): ResolvedChild {
  let list = kids, cur: ResolvedChild | undefined;
  for (const [i, seg] of path.entries()) {
    cur = list.find((c) => c.name === seg);
    if (!cur) throw new Error(`${where}/${path.slice(0, i + 1).join('/')}: その子はありません${suggest(seg, list.map((c) => c.name))}`);
    list = cur.children;
  }
  return cur!;
}

/** プレハブと、そのすべての子（書いてある中身。子にしたプレハブの子は、変えた値の入れ物）の [住所, 部品]。参照を数える・名前を直す所で使う */
export function prefabHolders(p: PrefabDoc): [string, Record<string, Record<string, unknown>>][] {
  const out: [string, Record<string, Record<string, unknown>>][] = [[`@${p.name}`, p.components]];
  const walk = (list: PrefabChild[] | undefined, at: string) => {
    for (const c of list ?? []) { const here = `${at}/${c.name}`; out.push([here, (c.components ??= {})]); walk(c.children, here); }
  };
  walk(p.children, `@${p.name}`);
  return out;
}

/** プレハブの子（書いてある中身）で、子にしたプレハブの名前を持つ所 */
export function childPrefabRefs(p: PrefabDoc): { at: string; node: PrefabChild }[] {
  const out: { at: string; node: PrefabChild }[] = [];
  const walk = (list: PrefabChild[] | undefined, at: string) => {
    for (const c of list ?? []) { const here = `${at}/${c.name}`; if (c.prefab) out.push({ at: here, node: c }); walk(c.children, here); }
  };
  walk(p.children, `@${p.name}`);
  return out;
}

/** 書いてある形の子の並びを、名前で重ねる（部品は欄ごと。どちらも 変えた値・中身のどちらの形でもよい） */
function mergeRaw(base: PrefabChild[], over: PrefabChild[] | undefined): PrefabChild[] {
  const out = structuredClone(base);
  for (const o of over ?? []) {
    const b = out.find((c) => c.name === o.name);
    if (!b) continue;
    for (const [c, v] of Object.entries(o.components ?? {})) b.components[c] = { ...(b.components[c] ?? {}), ...structuredClone(v) };
    if (o.remove?.length) b.remove = [...new Set([...(b.remove ?? []), ...o.remove])];
    if (o.children?.length) b.children = mergeRaw(b.children ?? [], o.children);
  }
  return out;
}

/** 派生を切り離すときの子: 元から順に、書いてある形のまま重ねた並び（子にしたプレハブとのつながりは残る） */
export function flatChildren(prefabs: Map<string, PrefabDoc>, name: string): PrefabChild[] {
  const chain = baseChain(prefabs, name).reverse();
  let kids: PrefabChild[] = structuredClone(chain[0].children ?? []);
  for (const d of chain.slice(1)) kids = mergeRaw(kids, d.children);
  return kids;
}
