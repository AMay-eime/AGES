// 差分編集。AIも人（エディタ）も、ファイルの変更はすべてここを通る。
// 返り値は「何がいくつからいくつに変わったか」だけ。
import { parseAddress, type Address, type EntityData, type PrefabDoc, type SceneDoc } from './docs.ts';
import { checkCell, checkValue, suggest, type CellValue } from './schema.ts';
import type { Registry } from './registry.ts';

export type Op =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'addEntity'; scene: string; entity: { id: string; name?: string; tags?: string[]; components?: Record<string, Record<string, unknown>> } }
  | { op: 'removeEntity'; scene: string; id: string }
  | { op: 'addComponent'; target: string; component: string; values?: Record<string, unknown> }
  | { op: 'removeComponent'; target: string; component: string }
  | { op: 'rename'; target: string; name: string }
  /** 行列の一部のセルだけを変える（行列全体を送らずに済む）。cells は [行, 列, 値] の並び */
  | { op: 'setCells'; path: string; cells: [number, number, CellValue][] };

/** "main#spawner.Spawner.formation[2,3]" → { path: "...formation", cell: [2,3] } */
export function splitCell(path: string): { path: string; cell?: [number, number] } {
  const m = path.match(/^(.*)\[(\d+),\s*(\d+)\]$/);
  return m ? { path: m[1], cell: [Number(m[2]), Number(m[3])] } : { path };
}

export interface Change {
  path: string;
  from?: unknown;
  to?: unknown;
}

export interface Docs {
  scenes: Map<string, SceneDoc>;
  prefabs: Map<string, PrefabDoc>;
}

export interface PatchResult {
  changes: Change[];
  /** 変更があった文書（"scene:main" / "prefab:enemy"） */
  dirty: Set<string>;
}

export class PatchError extends Error {
  opIndex: number;
  constructor(opIndex: number, message: string) {
    super(`操作${opIndex + 1}: ${message}`);
    this.opIndex = opIndex;
  }
}

type Holder = { components: Record<string, Record<string, unknown>>; name?: string };

function holderOf(docs: Docs, a: Address): { holder: Holder; key: string } {
  if (a.kind === 'prefab') {
    const p = docs.prefabs.get(a.doc);
    if (!p) throw new Error(`プレハブ ${a.doc} はありません${suggest(a.doc, [...docs.prefabs.keys()])}`);
    return { holder: p, key: `prefab:${a.doc}` };
  }
  const s = docs.scenes.get(a.doc);
  if (!s) throw new Error(`シーン ${a.doc} はありません${suggest(a.doc, [...docs.scenes.keys()])}`);
  const e = s.entities.find((x) => x.id === a.entity);
  if (!e) throw new Error(`シーン ${a.doc} にエンティティ ${a.entity} はありません${suggest(a.entity!, s.entities.map((x) => x.id))}`);
  return { holder: e, key: `scene:${a.doc}` };
}

/** 値を読む。フィールドが省略されていれば既定値を返す（isDefault=true）。 */
export function getValue(docs: Docs, reg: Registry, path: string): { value: unknown; isDefault: boolean } {
  const a = parseAddress(path);
  const { holder } = holderOf(docs, a);
  if (!a.component) return { value: holder, isDefault: false };
  const comp = holder.components[a.component];
  if (!comp) throw new Error(`${path}: コンポーネント ${a.component} が付いていません${suggest(a.component, Object.keys(holder.components))}`);
  if (!a.field) return { value: comp, isDefault: false };
  const def = reg.component(a.component);
  const f = def.fields[a.field];
  if (!f) throw new Error(`${a.component} に ${a.field} はありません${suggest(a.field, Object.keys(def.fields))}`);
  return a.field in comp ? { value: comp[a.field], isDefault: false } : { value: f.default, isDefault: true };
}

/** 操作をまとめて適用する。1つでも失敗したら何も変えない。 */
export function applyOps(docs: Docs, reg: Registry, ops: Op[]): PatchResult {
  const work: Docs = { scenes: structuredClone(docs.scenes), prefabs: structuredClone(docs.prefabs) };
  const changes: Change[] = [];
  const dirty = new Set<string>();
  ops.forEach((op, i) => {
    try {
      applyOne(work, reg, op, changes, dirty);
    } catch (err) {
      throw new PatchError(i, err instanceof Error ? err.message : String(err));
    }
  });
  // 成功したら本物に反映
  for (const k of dirty) {
    const [kind, name] = k.split(':');
    if (kind === 'scene') docs.scenes.set(name, work.scenes.get(name)!);
    else docs.prefabs.set(name, work.prefabs.get(name)!);
  }
  return { changes, dirty };
}

function applyOne(docs: Docs, reg: Registry, op: Op, changes: Change[], dirty: Set<string>): void {
  switch (op.op) {
    case 'set': {
      const a = parseAddress(op.path);
      if (!a.component || !a.field) throw new Error(`set にはフィールドまでのアドレスが必要です（例: main#player.Mover.speed）。受け取った値: ${op.path}`);
      const { holder, key } = holderOf(docs, a);
      const comp = holder.components[a.component];
      if (!comp) throw new Error(`${op.path}: コンポーネント ${a.component} が付いていません。先に addComponent が必要です`);
      const def = reg.component(a.component);
      const f = def.fields[a.field];
      if (!f) throw new Error(`${a.component} に ${a.field} はありません${suggest(a.field, Object.keys(def.fields))}`);
      const err = checkValue(a.component, a.field, f, op.value);
      if (err) throw new Error(err);
      if (f.type === 'prefab' && !docs.prefabs.has(op.value as string)) {
        throw new Error(`プレハブ ${op.value} はありません${suggest(String(op.value), [...docs.prefabs.keys()])}`);
      }
      const from = a.field in comp ? comp[a.field] : f.default;
      if (JSON.stringify(from) === JSON.stringify(op.value)) return;
      comp[a.field] = structuredClone(op.value);
      changes.push({ path: op.path, from, to: op.value });
      dirty.add(key);
      return;
    }
    case 'setCells': {
      const a = parseAddress(op.path);
      if (!a.component || !a.field) throw new Error(`setCells にはフィールドまでのアドレスが必要です: ${op.path}`);
      const { holder, key } = holderOf(docs, a);
      const comp = holder.components[a.component];
      if (!comp) throw new Error(`${op.path}: コンポーネント ${a.component} が付いていません`);
      const def = reg.component(a.component);
      const f = def.fields[a.field];
      if (!f) throw new Error(`${a.component} に ${a.field} はありません${suggest(a.field, Object.keys(def.fields))}`);
      if (f.type !== 'matrix') throw new Error(`${op.path} は行列ではありません（${f.type}）。set を使ってください`);
      const m = structuredClone((a.field in comp ? comp[a.field] : f.default) as CellValue[][]);
      for (const [r, c, v] of op.cells) {
        if (!m[r] || c < 0 || c >= m[r].length) throw new Error(`${op.path}[${r},${c}] は範囲外です（大きさ ${m.length}x${m[0]?.length ?? 0}、0から数えます）`);
        const err = checkCell(`${a.component}.${a.field}`, f, r, c, v);
        if (err) throw new Error(err);
        if (m[r][c] === v) continue;
        changes.push({ path: `${op.path}[${r},${c}]`, from: m[r][c], to: v });
        m[r][c] = v;
        dirty.add(key);
      }
      comp[a.field] = m;
      return;
    }
    case 'addEntity': {
      const s = docs.scenes.get(op.scene);
      if (!s) throw new Error(`シーン ${op.scene} はありません${suggest(op.scene, [...docs.scenes.keys()])}`);
      if (!/^[A-Za-z0-9_-]+$/.test(op.entity.id)) throw new Error(`エンティティID "${op.entity.id}" には英数字・_・- だけが使えます`);
      if (s.entities.some((e) => e.id === op.entity.id)) throw new Error(`シーン ${op.scene} に ${op.entity.id} はすでにあります`);
      const comps = op.entity.components ?? {};
      for (const [name, values] of Object.entries(comps)) reg.build(name, values, `${op.scene}#${op.entity.id}`);
      const e: EntityData = { id: op.entity.id, name: op.entity.name ?? op.entity.id, components: structuredClone(comps) };
      if (op.entity.tags?.length) e.tags = [...op.entity.tags];
      s.entities.push(e);
      changes.push({ path: `${op.scene}#${e.id}`, to: 'added' });
      dirty.add(`scene:${op.scene}`);
      return;
    }
    case 'removeEntity': {
      const s = docs.scenes.get(op.scene);
      if (!s) throw new Error(`シーン ${op.scene} はありません`);
      const i = s.entities.findIndex((e) => e.id === op.id);
      if (i < 0) throw new Error(`シーン ${op.scene} に ${op.id} はありません${suggest(op.id, s.entities.map((e) => e.id))}`);
      const [removed] = s.entities.splice(i, 1);
      changes.push({ path: `${op.scene}#${op.id}`, from: removed, to: 'removed' });
      dirty.add(`scene:${op.scene}`);
      return;
    }
    case 'addComponent': {
      const a = parseAddress(op.target);
      const { holder, key } = holderOf(docs, a);
      if (holder.components[op.component]) throw new Error(`${op.target} にはすでに ${op.component} が付いています`);
      reg.build(op.component, op.values ?? {}, op.target);
      holder.components[op.component] = structuredClone(op.values ?? {});
      changes.push({ path: `${op.target}.${op.component}`, to: 'added' });
      dirty.add(key);
      return;
    }
    case 'removeComponent': {
      const a = parseAddress(op.target);
      const { holder, key } = holderOf(docs, a);
      if (!holder.components[op.component]) throw new Error(`${op.target} に ${op.component} は付いていません${suggest(op.component, Object.keys(holder.components))}`);
      const from = holder.components[op.component];
      delete holder.components[op.component];
      changes.push({ path: `${op.target}.${op.component}`, from, to: 'removed' });
      dirty.add(key);
      return;
    }
    case 'rename': {
      const a = parseAddress(op.target);
      const { holder, key } = holderOf(docs, a);
      const from = holder.name;
      holder.name = op.name;
      changes.push({ path: `${op.target}:name`, from, to: op.name });
      dirty.add(key);
      return;
    }
    default:
      throw new Error(`未知の操作 ${(op as { op: string }).op}。使えるのは set / setCells / addEntity / removeEntity / addComponent / removeComponent / rename`);
  }
}

/** 値を文字列から推測して変換する（CLIの set 用）。 */
export function parseLiteral(text: string): unknown {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(text)) return Number(text);
  if (/^[[{"]/.test(text)) {
    try { return JSON.parse(text); } catch { /* 文字列として扱う */ }
  }
  return text;
}

/** 2つの文書の違いを値の単位で求める（テキスト編集や外部からの編集をログに残すため）。 */
export function diffDocs(before: Docs, after: Docs): Change[] {
  const out: Change[] = [];
  type H = { components: Record<string, Record<string, unknown>> };
  const diffHolder = (base: string, a: H | undefined, b: H | undefined) => {
    if (!a && b) { out.push({ path: base, to: 'added' }); return; }
    if (a && !b) { out.push({ path: base, from: a, to: 'removed' }); return; }
    if (!a || !b) return;
    for (const name of new Set([...Object.keys(a.components), ...Object.keys(b.components)])) {
      const ca = a.components[name], cb = b.components[name];
      if (!ca) { out.push({ path: `${base}.${name}`, to: 'added' }); continue; }
      if (!cb) { out.push({ path: `${base}.${name}`, from: ca, to: 'removed' }); continue; }
      for (const k of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
        if (JSON.stringify(ca[k]) !== JSON.stringify(cb[k])) out.push({ path: `${base}.${name}.${k}`, from: ca[k], to: cb[k] });
      }
    }
  };
  for (const name of new Set([...before.scenes.keys(), ...after.scenes.keys()])) {
    const sa = before.scenes.get(name), sb = after.scenes.get(name);
    const ids = new Set([...(sa?.entities ?? []).map((e) => e.id), ...(sb?.entities ?? []).map((e) => e.id)]);
    for (const id of ids) diffHolder(`${name}#${id}`, sa?.entities.find((e) => e.id === id), sb?.entities.find((e) => e.id === id));
  }
  for (const name of new Set([...before.prefabs.keys(), ...after.prefabs.keys()])) {
    diffHolder(`@${name}`, before.prefabs.get(name), after.prefabs.get(name));
  }
  return out;
}
