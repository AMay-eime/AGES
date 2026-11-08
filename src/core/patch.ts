// 差分編集。AIも人（エディタ）も、ファイルの変更はすべてここを通る。
// 返り値は「何がいくつからいくつに変わったか」だけ。
import { formatSub, getIn, parseAddress, setIn, type Address, type EntityData, type PrefabDoc, type SceneDoc } from './docs.ts';
import { checkAt, checkCell, defaultOf, filled, mapLeaves, suggest, type CellValue, type Field } from './schema.ts';
import { ROW_ID, type Row, type TableDoc } from './table.ts';
import type { Registry } from './registry.ts';
import { baseNameOf, checkSheet, findFrame, sheetPathOf, toExplicit, type FrameDef, type FrameRef, type SheetDef } from './sheet.ts';
import { frameMapper, remapRef } from './slice.ts';
import { assetRefs, checkAssetPath, extOf, isUnder, kindOf } from './assets.ts';

export type Op =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'addEntity'; scene: string; entity: { id: string; name?: string; tags?: string[]; components?: Record<string, Record<string, unknown>> } }
  | { op: 'removeEntity'; scene: string; id: string }
  | { op: 'addComponent'; target: string; component: string; values?: Record<string, unknown> }
  | { op: 'removeComponent'; target: string; component: string }
  | { op: 'rename'; target: string; name: string }
  /** 行列の一部のセルだけを変える（行列全体を送らずに済む）。cells は [行, 列, 値] の並び */
  | { op: 'setCells'; path: string; cells: [number, number, CellValue][] }
  /**
   * 画像の切り方（スプライトシート）をまるごと決める。null で消す。
   * renames に { 古い名前: 新しい名前 } を渡すと、シーン・プレハブ・動きの中のコマの指定も書き換える
   */
  | { op: 'setSheet'; image: string; sheet: SheetDef | null; renames?: Record<string, string> }
  /**
   * コマを1つ変える・足す・消す。frame は番号か名前。ない名前に rect を付けると追加。
   * name で名前を変える（参照も書き換える）。pivot: null で基準点を外す。remove: true で消す
   */
  | { op: 'setFrame'; image: string; frame: FrameRef; name?: string; rect?: FrameDef['rect']; pivot?: [number, number] | null; remove?: boolean }
  /** 動きを1つ変える・足す・消す。ない名前は追加（frames と fps が必要） */
  | { op: 'setClip'; image: string; clip: string; frames?: FrameRef[]; fps?: number; loop?: boolean; remove?: boolean }
  /** リストに足す。path はリストの住所（例 main#spawner.Spawner.waves）。index を省くと最後。value を省くと既定値 */
  | { op: 'insert'; path: string; value?: unknown; index?: number }
  /** リストから消す。path は要素の住所（例 main#spawner.Spawner.waves[2]） */
  | { op: 'removeItem'; path: string }
  /** リストの中で動かす。path は要素の住所、to は動かした後の番号 */
  | { op: 'moveItem'; path: string; to: number }
  /** 表に行を足す。row には id が要る。省いた列は既定値。index を省くと最後 */
  | { op: 'addRow'; table: string; row: Row; index?: number }
  /** 表から行を消す */
  | { op: 'removeRow'; table: string; id: string }
  /** 表の中で行を動かす（to は動かした後の番号） */
  | { op: 'moveRow'; table: string; id: string; to: number }
  /** 行の ID を変える。その行を指している値（row 型）も書き換える */
  | { op: 'renameRow'; table: string; id: string; to: string }
  /** ファイル（かフォルダ）の場所を変える。使っている値も直る。画像の切り方（.sheet.json）も一緒に動く */
  | { op: 'moveAsset'; from: string; to: string }
  /** ファイル（かフォルダ）を消す。使われているものは消せない */
  | { op: 'removeAsset'; path: string };

/** シートの値の住所。sheet:<画像>（全体）、sheet:<画像>|<コマ>.rect、sheet:<画像>|clip:<動き>.fps */
export const sheetAddress = (image: string, rest = '') => `sheet:${image}${rest ? '|' + rest : ''}`;
/** シートの住所から、シート全体の住所（ロック・★の単位）を取り出す */
export const sheetRoot = (path: string) => (path.startsWith('sheet:') ? path.split('|')[0] : path);

/** "main#spawner.Spawner.formation[2,3]" → { path: "...formation", cell: [2,3] } */
export function splitCell(path: string): { path: string; cell?: [number, number] } {
  const m = path.match(/^(.*)\[(\d+),\s*(\d+)\]$/);
  return m ? { path: m[1], cell: [Number(m[2]), Number(m[3])] } : { path };
}

export interface Change {
  path: string;
  from?: unknown;
  to?: unknown;
  /** 別の変更に合わせて自動で直したもの（コマの名前の変更や番号のずれに合わせた参照など）。人が調整した印（★）は付けない */
  auto?: boolean;
}

export interface Docs {
  scenes: Map<string, SceneDoc>;
  prefabs: Map<string, PrefabDoc>;
  /** スプライトシート（画像の場所 → 切り方）。ファイルは画像の隣の <画像名>.sheet.json */
  sheets: Map<string, SheetDef>;
  /** 表（名前 → 行）。ファイルは data/<名前>.table.json */
  tables: Map<string, TableDoc>;
  /** プロジェクトの中のファイルの場所（アセットの移動・削除で使う。ないときはその操作ができない） */
  files?: Set<string>;
}

/** 文書の変更に合わせて行うファイルの操作（to が null なら消す） */
export interface FileOp {
  from: string;
  to: string | null;
  dir: boolean;
}

export interface PatchResult {
  changes: Change[];
  /** 変更があった文書（"scene:main" / "prefab:enemy" / "sheet:assets/x.png" / "table:enemies"） */
  dirty: Set<string>;
  /** ファイルの移動・削除（保存の前に行う） */
  files: FileOp[];
  /** 気をつけること（コードの中に書かれた場所は直していない、など） */
  warnings?: string[];
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

/** フィールド（表なら列）の中の、ある場所。読む・書くの両方に使う */
interface Slot {
  /** フィールドの型 */
  top: Field;
  /** フィールドの今の値（省略されていれば既定値） */
  topValue: unknown;
  isDefault: boolean;
  sub: (string | number)[];
  /** その場所の型と値 */
  field: Field;
  value: unknown;
  /** 検証のメッセージに使う場所（例 Spawner.waves、$enemies.basic.hp） */
  at: string;
  /** 変更のあった文書 */
  key: string;
  /** フィールドの値をまるごと書く */
  write(top: unknown): void;
}

/** フィールドの中を sub に沿って進む。ない場所は、どこが違うかを示して止める */
function walk(at: string, top: Field, topValue: unknown, sub: (string | number)[]): { field: Field; value: unknown } {
  let f = top, v = topValue, where = at;
  for (const seg of sub) {
    if (f.type === 'list') {
      if (typeof seg !== 'number') throw new Error(`${where} はリストです。中は [番号] で指します（例 ${where}[0]）`);
      const n = Array.isArray(v) ? v.length : 0;
      if (seg >= n) throw new Error(`${where}[${seg}] は範囲外です（${n} 個、0から数えます）`);
      f = f.of; v = (v as unknown[])[seg]; where += `[${seg}]`;
    } else if (f.type === 'struct') {
      if (typeof seg !== 'string' || !f.fields[seg]) throw new Error(`${where} に ${seg} という項目はありません${suggest(String(seg), Object.keys(f.fields))}（ある項目: ${Object.keys(f.fields).join(', ')}）`);
      f = f.fields[seg]; v = (v as Record<string, unknown> | undefined)?.[seg] ?? defaultOf(f); where += `.${seg}`;
    } else if (f.type === 'oneOf') {
      const kind = (v as { kind?: string } | undefined)?.kind ?? Object.keys(f.variants)[0];
      if (seg === 'kind') { f = { type: 'enum', options: Object.keys(f.variants), default: kind }; v = kind; where += '.kind'; continue; }
      const vf = f.variants[kind]?.fields ?? {};
      if (typeof seg !== 'string' || !vf[seg]) throw new Error(`${where}（種類 ${kind}）に ${seg} という項目はありません${suggest(String(seg), Object.keys(vf))}（ある項目: kind, ${Object.keys(vf).join(', ')}）`);
      f = vf[seg]; v = (v as Record<string, unknown> | undefined)?.[seg] ?? defaultOf(f); where += `.${seg}`;
    } else throw new Error(`${where} は ${f.type} なので、中に ${typeof seg === 'number' ? `[${seg}]` : '.' + seg} はありません`);
  }
  return { field: f, value: v };
}

function tableOf(docs: Docs, reg: Registry, name: string): TableDoc {
  reg.table(name);
  let t = docs.tables.get(name);
  if (!t) { t = { name, rows: [] }; docs.tables.set(name, t); }
  return t;
}

function slotOf(docs: Docs, reg: Registry, a: Address, path: string): Slot {
  if (a.kind === 'table') {
    if (!a.entity || !a.field) throw new Error(`表の値は $表.行.列 で指します（例 $enemies.basic.hp）。受け取った値: ${path}`);
    const def = reg.table(a.doc);
    const t = tableOf(docs, reg, a.doc);
    const row = t.rows.find((r) => r.id === a.entity);
    if (!row) throw new Error(`表 ${a.doc} に行 ${a.entity} はありません${suggest(a.entity, t.rows.map((r) => r.id))}`);
    if (a.field === 'id') throw new Error(`行の ID は renameRow で変えます（その行を指している値も書き換わります）`);
    const top = def.columns[a.field];
    if (!top) throw new Error(`表 ${a.doc} に列 ${a.field} はありません${suggest(a.field, Object.keys(def.columns))}（ある列: id, ${Object.keys(def.columns).join(', ')}）`);
    const has = a.field in row;
    const topValue = has ? row[a.field] : defaultOf(top);
    const at = `$${a.doc}.${a.entity}.${a.field}`;
    return { top, topValue, isDefault: !has, sub: a.sub, ...walk(at, top, topValue, a.sub), at, key: `table:${a.doc}`, write: (v) => { row[a.field!] = v; } };
  }
  if (!a.component || !a.field) throw new Error(`フィールドまでのアドレスが必要です（例: main#player.Mover.speed）。受け取った値: ${path}`);
  const { holder, key } = holderOf(docs, a);
  const comp = holder.components[a.component];
  if (!comp) throw new Error(`${path}: コンポーネント ${a.component} が付いていません${suggest(a.component, Object.keys(holder.components))}`);
  const def = reg.component(a.component);
  const top = def.fields[a.field];
  if (!top) throw new Error(`${a.component} に ${a.field} はありません${suggest(a.field, Object.keys(def.fields))}`);
  const has = a.field in comp;
  const topValue = has ? comp[a.field] : defaultOf(top);
  const at = `${a.component}.${a.field}`;
  return { top, topValue, isDefault: !has, sub: a.sub, ...walk(at, top, topValue, a.sub), at, key, write: (v) => { comp[a.field!] = v; } };
}

/** 値を読む。フィールドが省略されていれば既定値を返す（isDefault=true）。 */
export function getValue(docs: Docs, reg: Registry, path: string): { value: unknown; isDefault: boolean } {
  if (path.startsWith('sheet:')) {
    const image = path.slice('sheet:'.length).split('|')[0];
    return { value: docs.sheets.get(image) ?? null, isDefault: false };
  }
  const a = parseAddress(path);
  if (a.kind === 'table') {
    if (a.field) { const s = slotOf(docs, reg, a, path); return { value: filled(s.field, s.value), isDefault: s.isDefault && !s.sub.length }; }
    reg.table(a.doc);
    const t = docs.tables.get(a.doc) ?? { name: a.doc, rows: [] };
    if (!a.entity) return { value: t, isDefault: false };
    const row = t.rows.find((r) => r.id === a.entity);
    if (!row) throw new Error(`表 ${a.doc} に行 ${a.entity} はありません${suggest(a.entity, t.rows.map((r) => r.id))}`);
    return { value: row, isDefault: false };
  }
  if (a.field) { const s = slotOf(docs, reg, a, path); return { value: filled(s.field, s.value), isDefault: s.isDefault && !s.sub.length }; }
  const { holder } = holderOf(docs, a);
  if (!a.component) return { value: holder, isDefault: false };
  const comp = holder.components[a.component];
  if (!comp) throw new Error(`${path}: コンポーネント ${a.component} が付いていません${suggest(a.component, Object.keys(holder.components))}`);
  return { value: comp, isDefault: false };
}

/** 値を直接書く（検証しない。ロックの値を戻すとき用）。書いた文書の key を返す */
export function setValue(docs: Docs, reg: Registry, path: string, value: unknown): string {
  if (path.startsWith('sheet:')) {
    const image = path.slice('sheet:'.length);
    if (value === null) docs.sheets.delete(image);
    else docs.sheets.set(image, structuredClone(value as SheetDef));
    return path;
  }
  const s = slotOf(docs, reg, parseAddress(path), path);
  s.write(setIn(s.topValue, s.sub, structuredClone(value)));
  return s.key;
}

/** 操作をまとめて適用する。1つでも失敗したら何も変えない。 */
export function applyOps(docs: Docs, reg: Registry, ops: Op[]): PatchResult {
  const work: Docs = { scenes: structuredClone(docs.scenes), prefabs: structuredClone(docs.prefabs), sheets: structuredClone(docs.sheets), tables: structuredClone(docs.tables), files: docs.files && new Set(docs.files) };
  const changes: Change[] = [];
  const dirty = new Set<string>();
  const files: FileOp[] = [];
  ops.forEach((op, i) => {
    try {
      if (op.op === 'moveAsset' || op.op === 'removeAsset') assetOp(work, reg, op, changes, dirty, files);
      else applyOne(work, reg, op, changes, dirty);
    } catch (err) {
      throw new PatchError(i, err instanceof Error ? err.message : String(err));
    }
  });
  // 成功したら本物に反映
  for (const k of dirty) {
    const i = k.indexOf(':');
    const kind = k.slice(0, i), name = k.slice(i + 1);
    if (kind === 'scene') docs.scenes.set(name, work.scenes.get(name)!);
    else if (kind === 'prefab') docs.prefabs.set(name, work.prefabs.get(name)!);
    else if (kind === 'table') docs.tables.set(name, work.tables.get(name)!);
    else if (work.sheets.has(name)) docs.sheets.set(name, work.sheets.get(name)!);
    else docs.sheets.delete(name);
  }
  if (files.length && docs.files && work.files) { docs.files.clear(); for (const f of work.files) docs.files.add(f); }
  return { changes, dirty, files };
}

function applyOne(docs: Docs, reg: Registry, op: Op, changes: Change[], dirty: Set<string>): void {
  switch (op.op) {
    case 'set': {
      const a = parseAddress(op.path);
      const sl = slotOf(docs, reg, a, op.path);
      const newTop = setIn(sl.topValue, sl.sub, op.value);
      const err = checkAt(sl.at, sl.top, newTop);
      if (err) throw new Error(err);
      if (sl.field.type === 'prefab' && op.value !== '' && !docs.prefabs.has(op.value as string)) {
        throw new Error(`プレハブ ${op.value} はありません${suggest(String(op.value), [...docs.prefabs.keys()])}`);
      }
      const from = sl.sub.length ? sl.value : sl.isDefault ? defaultOf(sl.top) : sl.topValue;
      if (JSON.stringify(from) === JSON.stringify(op.value)) return;
      sl.write(structuredClone(newTop));
      changes.push({ path: op.path, from, to: op.value });
      dirty.add(sl.key);
      return;
    }
    case 'setCells': {
      const a = parseAddress(op.path);
      const sl = slotOf(docs, reg, a, op.path);
      const f = sl.field;
      if (f.type !== 'matrix') throw new Error(`${op.path} は行列ではありません（${f.type}）。set を使ってください`);
      const m = structuredClone(sl.value as CellValue[][]);
      let changed = false;
      for (const [r, c, v] of op.cells) {
        if (!m[r] || c < 0 || c >= m[r].length) throw new Error(`${op.path}[${r},${c}] は範囲外です（大きさ ${m.length}x${m[0]?.length ?? 0}、0から数えます）`);
        const err = checkCell(sl.at + formatSub(sl.sub), f, r, c, v);
        if (err) throw new Error(err);
        if (m[r][c] === v) continue;
        changes.push({ path: `${op.path}[${r},${c}]`, from: m[r][c], to: v });
        m[r][c] = v;
        changed = true;
      }
      if (changed) { sl.write(setIn(sl.topValue, sl.sub, m)); dirty.add(sl.key); }
      return;
    }
    case 'insert': {
      const a = parseAddress(op.path);
      const sl = slotOf(docs, reg, a, op.path);
      if (sl.field.type !== 'list') throw new Error(`${op.path} はリストではありません（${sl.field.type}）`);
      const list = [...((sl.value as unknown[]) ?? [])];
      const i = op.index ?? list.length;
      if (!Number.isInteger(i) || i < 0 || i > list.length) throw new Error(`insert の index=${i} は範囲外です（0〜${list.length}）`);
      const value = op.value === undefined ? defaultOf(sl.field.of) : structuredClone(op.value);
      list.splice(i, 0, value);
      const newTop = setIn(sl.topValue, sl.sub, list);
      const err = checkAt(sl.at, sl.top, newTop);
      if (err) throw new Error(err);
      sl.write(newTop);
      changes.push({ path: `${op.path}[${i}]`, from: undefined, to: 'added' });
      dirty.add(sl.key);
      return;
    }
    case 'removeItem':
    case 'moveItem': {
      const { list: listPath, index } = splitItem(op.path);
      const a = parseAddress(listPath);
      const sl = slotOf(docs, reg, a, listPath);
      if (sl.field.type !== 'list') throw new Error(`${listPath} はリストではありません（${sl.field.type}）`);
      const list = [...((sl.value as unknown[]) ?? [])];
      if (index >= list.length) throw new Error(`${op.path} は範囲外です（${list.length} 個、0から数えます）`);
      const [item] = list.splice(index, 1);
      if (op.op === 'moveItem') {
        if (!Number.isInteger(op.to) || op.to < 0 || op.to > list.length) throw new Error(`moveItem の to=${op.to} は範囲外です（0〜${list.length}）`);
        if (op.to === index) return;
        list.splice(op.to, 0, item);
      }
      const newTop = setIn(sl.topValue, sl.sub, list);
      const err = checkAt(sl.at, sl.top, newTop);
      if (err) throw new Error(err);
      sl.write(newTop);
      changes.push(op.op === 'removeItem' ? { path: op.path, from: item, to: 'removed' } : { path: op.path, from: `[${index}]`, to: `moved:[${op.to}]` });
      dirty.add(sl.key);
      return;
    }
    case 'addRow': {
      const def = reg.table(op.table);
      const t = tableOf(docs, reg, op.table);
      const id = op.row?.id;
      if (typeof id !== 'string' || !ROW_ID.test(id)) throw new Error(`行の id "${id}" には英数字・_・- だけが使えます`);
      if (t.rows.some((r) => r.id === id)) throw new Error(`表 ${op.table} に行 ${id} はすでにあります`);
      const { id: _id, ...cols } = op.row;
      for (const [k, v] of Object.entries(cols)) {
        const f = def.columns[k];
        if (!f) throw new Error(`表 ${op.table} に列 ${k} はありません${suggest(k, Object.keys(def.columns))}（ある列: ${Object.keys(def.columns).join(', ')}）`);
        const err = checkAt(`$${op.table}.${id}.${k}`, f, v);
        if (err) throw new Error(err);
      }
      const i = op.index ?? t.rows.length;
      if (!Number.isInteger(i) || i < 0 || i > t.rows.length) throw new Error(`addRow の index=${i} は範囲外です（0〜${t.rows.length}）`);
      t.rows.splice(i, 0, structuredClone(op.row));
      changes.push({ path: `$${op.table}.${id}`, to: 'added' });
      dirty.add(`table:${op.table}`);
      return;
    }
    case 'removeRow':
    case 'moveRow': {
      const t = tableOf(docs, reg, op.table);
      const i = t.rows.findIndex((r) => r.id === op.id);
      if (i < 0) throw new Error(`表 ${op.table} に行 ${op.id} はありません${suggest(op.id, t.rows.map((r) => r.id))}`);
      const [row] = t.rows.splice(i, 1);
      if (op.op === 'moveRow') {
        if (!Number.isInteger(op.to) || op.to < 0 || op.to > t.rows.length) throw new Error(`moveRow の to=${op.to} は範囲外です（0〜${t.rows.length}）`);
        t.rows.splice(op.to, 0, row);
        if (op.to === i) return;
        changes.push({ path: `$${op.table}.${op.id}`, from: `#${i}`, to: `#${op.to}` });
      } else changes.push({ path: `$${op.table}.${op.id}`, from: row, to: 'removed' });
      dirty.add(`table:${op.table}`);
      return;
    }
    case 'renameRow': {
      const t = tableOf(docs, reg, op.table);
      const row = t.rows.find((r) => r.id === op.id);
      if (!row) throw new Error(`表 ${op.table} に行 ${op.id} はありません${suggest(op.id, t.rows.map((r) => r.id))}`);
      if (!ROW_ID.test(op.to)) throw new Error(`行の id "${op.to}" には英数字・_・- だけが使えます`);
      if (op.to === op.id) return;
      if (t.rows.some((r) => r.id === op.to)) throw new Error(`表 ${op.table} に行 ${op.to} はすでにあります`);
      row.id = op.to;
      changes.push({ path: `$${op.table}.${op.id}`, from: op.id, to: `renamed:${op.to}` });
      dirty.add(`table:${op.table}`);
      renameRowRefs(docs, reg, op.table, op.id, op.to, changes, dirty);
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
    case 'setSheet': {
      if (op.sheet !== null) {
        const errs = checkSheet(sheetPathOf(op.image), op.sheet);
        if (!reg.images.has(op.image)) throw new Error(`画像 ${op.image} がありません${suggest(op.image, [...reg.images.keys()])}`);
        if (errs.length) throw new Error(errs.join(' / '));
      }
      const key = op.image;
      const before = docs.sheets.get(key);
      if (op.sheet === null) docs.sheets.delete(key);
      else docs.sheets.set(key, structuredClone(op.sheet));
      const diff = diffSheet(op.image, before, op.sheet ?? undefined);
      if (diff.length) { changes.push(...diff); dirty.add(`sheet:${key}`); }
      for (const [from, to] of Object.entries(op.renames ?? {})) if (from !== to) renameRefs(docs, op.image, from, to, changes, dirty, false);
      // 番号で指定しているシーン・プレハブのコマを、新しい切り方に合わせる（op.sheet の動きは新しい切り方で書かれている前提）
      const size = reg.images.get(op.image);
      if (before && op.sheet && size) remapSprites(docs, op.image, frameMapper(before, op.sheet, size.w, size.h, op.renames), op.sheet, changes, dirty);
      return;
    }
    case 'setFrame': {
      const key = op.image;
      const before = docs.sheets.get(key);
      const size = reg.images.get(op.image);
      if (!size) throw new Error(`画像 ${op.image} がありません${suggest(op.image, [...reg.images.keys()])}`);
      // シートがなければ空から作る。格子のシートは、同じ並びの自由な矩形にしてから変える（番号での指定はそのまま使える）
      const sheet = before ? toExplicit(before, size.w, size.h, baseNameOf(op.image)) : { frames: [] };
      const frames = sheet.frames!;
      const found = findFrame(sheet, 0, 0, op.frame);
      if (!found) {
        if (op.remove || !op.rect || typeof op.frame !== 'string') {
          const names = frames.map((f) => f.name);
          throw new Error(`${op.image} に コマ ${JSON.stringify(op.frame)} はありません（${frames.length}コマ）${typeof op.frame === 'string' ? suggest(op.frame, names) : ''}。追加するなら名前と rect を指定してください`);
        }
        const f: FrameDef = { name: op.frame, rect: op.rect };
        if (op.pivot) f.pivot = op.pivot;
        frames.push(f);
      } else if (op.remove) {
        frames.splice(found.index, 1);
      } else {
        const f = frames[found.index];
        if (op.rect) f.rect = op.rect;
        if (op.pivot === null) delete f.pivot;
        else if (op.pivot) f.pivot = op.pivot;
        if (op.name !== undefined && op.name !== f.name) {
          const old = f.name;
          f.name = op.name;
          renameInClips(sheet, old, op.name);
          renameRefs(docs, op.image, old, op.name, changes, dirty, true);
        }
      }
      if (before) {
        // 消したコマより後ろの番号がずれるので、番号での指定を合わせる
        const map = frameMapper(before, sheet, size.w, size.h, op.name !== undefined && found ? { [found.name ?? '']: op.name } : {});
        for (const [cn, c] of Object.entries(sheet.clips ?? {})) {
          c.frames = c.frames.map((r) => {
            const n = remapRef(r, map, sheet);
            if (n === null) throw new Error(`動き ${cn} が コマ #${r} を使っています。先に動きから外してください（setClip）`);
            return n;
          });
        }
        remapSprites(docs, op.image, map, sheet, changes, dirty);
      }
      const errs = checkSheet(sheetPathOf(key), sheet);
      if (errs.length) throw new Error(errs.join(' / '));
      docs.sheets.set(key, sheet);
      const diff = diffSheet(op.image, before, sheet);
      if (diff.length) { changes.push(...diff); dirty.add(`sheet:${key}`); }
      return;
    }
    case 'setClip': {
      const key = op.image;
      const before = docs.sheets.get(key);
      if (!before) throw new Error(`${op.image} にはスプライトシートがありません`);
      const sheet = structuredClone(before);
      const clips = (sheet.clips ??= {});
      if (op.remove) {
        if (!clips[op.clip]) throw new Error(`${op.image} に動き ${op.clip} はありません${suggest(op.clip, Object.keys(clips))}`);
        delete clips[op.clip];
      } else {
        const c = clips[op.clip] ?? (op.frames && op.fps ? { frames: op.frames, fps: op.fps } : null);
        if (!c) throw new Error(`動き ${op.clip} を追加するには frames と fps が必要です`);
        if (op.frames) c.frames = op.frames;
        if (op.fps !== undefined) c.fps = op.fps;
        if (op.loop !== undefined) { if (op.loop) delete c.loop; else c.loop = false; }
        clips[op.clip] = c;
      }
      if (!Object.keys(clips).length) delete sheet.clips;
      const errs = checkSheet(sheetPathOf(key), sheet);
      if (errs.length) throw new Error(errs.join(' / '));
      docs.sheets.set(key, sheet);
      const diff = diffSheet(op.image, before, sheet);
      if (diff.length) { changes.push(...diff); dirty.add(`sheet:${key}`); }
      return;
    }
    default:
      throw new Error(`未知の操作 ${(op as { op: string }).op}。使えるのは set / setCells / insert / removeItem / moveItem / addEntity / removeEntity / addComponent / removeComponent / rename / addRow / removeRow / moveRow / renameRow / setSheet / setFrame / setClip`);
  }
}

/** "…waves[2]" → { list: "…waves", index: 2 } */
export function splitItem(path: string): { list: string; index: number } {
  const m = path.match(/^(.*)\[(\d+)\]$/);
  if (!m) throw new Error(`リストの要素の住所が必要です（例 main#spawner.Spawner.waves[2]）。受け取った値: ${path}`);
  return { list: m[1], index: Number(m[2]) };
}

/** 行の ID を変えたとき、その行を指している値（row 型。入れ子の中も）を書き換える */
function renameRowRefs(docs: Docs, reg: Registry, table: string, from: string, to: string, changes: Change[], dirty: Set<string>): void {
  fixLeaves(docs, reg, (f, v) => (f.type === 'row' && f.table === table && v === from ? to : undefined), changes, dirty);
}

/** シーン・プレハブ・表のすべての値の葉を fix で直す（直したものは自動の変更として記録） */
function fixLeaves(docs: Docs, reg: Registry, fix: (f: Field, v: unknown) => unknown, changes: Change[], dirty: Set<string>): void {
  const fixHolder = (base: string, comps: Record<string, Record<string, unknown>>, key: string) => {
    for (const [cname, values] of Object.entries(comps)) {
      const def = reg.components.get(cname);
      if (!def) continue;
      for (const [k, f] of Object.entries(def.fields)) {
        if (!(k in values)) continue;
        const next = mapLeaves(f, values[k], fix);
        if (JSON.stringify(next) === JSON.stringify(values[k])) continue;
        changes.push({ path: `${base}.${cname}.${k}`, from: values[k], to: next, auto: true });
        values[k] = next;
        dirty.add(key);
      }
    }
  };
  for (const s of docs.scenes.values()) for (const e of s.entities) fixHolder(`${s.name}#${e.id}`, e.components, `scene:${s.name}`);
  for (const p of docs.prefabs.values()) fixHolder(`@${p.name}`, p.components, `prefab:${p.name}`);
  for (const t of docs.tables.values()) {
    const def = reg.tables.get(t.name);
    if (!def) continue;
    for (const r of t.rows) {
      for (const [k, f] of Object.entries(def.columns)) {
        if (!(k in r)) continue;
        const next = mapLeaves(f, r[k], fix);
        if (JSON.stringify(next) === JSON.stringify(r[k])) continue;
        changes.push({ path: `$${t.name}.${r.id}.${k}`, from: r[k], to: next, auto: true });
        r[k] = next;
        dirty.add(`table:${t.name}`);
      }
    }
  }
}

/** アセットの移動・削除。ファイルそのものは呼び出し側が files に従って動かす */
function assetOp(docs: Docs, reg: Registry, op: Extract<Op, { op: 'moveAsset' | 'removeAsset' }>, changes: Change[], dirty: Set<string>, fileOps: FileOp[]): void {
  const files = docs.files;
  if (!files) throw new Error(`${op.op} はプロジェクトのファイルの一覧がないと使えません`);
  const norm = (p: unknown, what: string) => {
    if (typeof p !== 'string') throw new Error(`${op.op} の ${what} にはファイルの場所（文字列）が必要です`);
    return p.replace(/\\/g, '/').replace(/\/+$/, '');
  };
  const from = norm(op.op === 'moveAsset' ? op.from : op.path, op.op === 'moveAsset' ? 'from' : 'path');
  const inside = [...files].filter((f) => isUnder(f, from));
  const dir = !files.has(from) && inside.length > 0;
  if (!files.has(from) && !dir) {
    const all = [...files].filter((f) => kindOf(f));
    throw new Error(`ファイル ${from} はありません${suggest(from, all)}`);
  }
  const targets = dir ? inside : [from];
  if (!dir && !kindOf(from)) throw new Error(`${from} は画像・音・フォントではありません（${op.op} はアセットだけ）`);
  if (op.op === 'removeAsset') {
    const refs = assetRefs(docs, reg);
    const used = targets.flatMap((t) => (refs.get(t) ?? []).map((at) => `${at}=${t}`));
    if (used.length) throw new Error(`${from} は使われているので消せません: ${used.slice(0, 5).join(', ')}${used.length > 5 ? ` ほか${used.length - 5}か所` : ''}。先にその指定を変えてください`);
    for (const t of targets) {
      files.delete(t);
      if (docs.sheets.delete(t)) dirty.add(`sheet:${t}`);
      const sp = sheetPathOf(t);
      if (!dir && files.delete(sp)) dirty.add(`sheet:${t}`);
    }
    fileOps.push({ from, to: null, dir });
    changes.push({ path: `file:${from}`, from, to: 'removed' });
    return;
  }
  const to = norm(op.to, 'to');
  const err = checkAssetPath(to);
  if (err) throw new Error(err);
  if (to === from) return;
  if (dir && isUnder(to, from)) throw new Error(`フォルダ ${from} を、その中（${to}）へは移せません`);
  if (!dir && [...files].some((f) => isUnder(f, to))) throw new Error(`${to} はフォルダです。中へ入れるなら ${to}/${from.slice(from.lastIndexOf('/') + 1)} のように名前まで書いてください`);
  if (!dir && extOf(to) !== extOf(from)) throw new Error(`拡張子は変えられません（${extOf(from)} → ${extOf(to) || 'なし'}）。中身の形式が変わらないため`);
  const map = new Map<string, string>(targets.map((t) => [t, dir ? to + t.slice(from.length) : to]));
  // 画像の切り方は、隣のファイルごと一緒に動く
  if (!dir && files.has(sheetPathOf(from))) map.set(sheetPathOf(from), sheetPathOf(to));
  for (const t of map.values()) if (files.has(t)) throw new Error(`${t} はすでにあります。別の名前にするか、先にそちらを動かしてください`);
  if (files.has(to)) throw new Error(`${to} はすでにあります`);
  for (const [f, t] of map) { files.delete(f); files.add(t); }
  for (const [img, def] of [...docs.sheets]) {
    const t = map.get(img);
    if (!t) continue;
    docs.sheets.delete(img);
    docs.sheets.set(t, def);
    dirty.add(`sheet:${img}`);
    dirty.add(`sheet:${t}`);
  }
  fileOps.push({ from, to, dir });
  changes.push({ path: `file:${from}`, from, to });
  fixLeaves(docs, reg, (f, v) => (f.type === 'asset' && typeof v === 'string' && map.has(v) ? map.get(v) : undefined), changes, dirty);
}

/** 切り方の変更で番号がずれたシーン・プレハブの Sprite.frame を直す。無くなったコマを使っていたら止める */
function remapSprites(docs: Docs, image: string, map: (i: number) => number, after: SheetDef, changes: Change[], dirty: Set<string>): void {
  const fix = (base: string, comps: Record<string, Record<string, unknown>>, dirtyKey: string) => {
    const sp = comps.Sprite;
    if (sp?.image !== image || typeof sp.frame !== 'number') return;
    const n = remapRef(sp.frame, map, after);
    if (n === null) throw new Error(`${base}.Sprite.frame=${sp.frame} のコマが、この切り方では無くなります。先にその指定を変えてください（名前で指定すると切り直してもずれません）`);
    if (n === sp.frame) return;
    changes.push({ path: `${base}.Sprite.frame`, from: sp.frame, to: n, auto: true });
    sp.frame = n;
    dirty.add(dirtyKey);
  };
  for (const s of docs.scenes.values()) for (const e of s.entities) fix(`${s.name}#${e.id}`, e.components, `scene:${s.name}`);
  for (const p of docs.prefabs.values()) fix(`@${p.name}`, p.components, `prefab:${p.name}`);
}

function renameInClips(sheet: SheetDef, from: string, to: string): void {
  for (const c of Object.values(sheet.clips ?? {})) c.frames = c.frames.map((r) => (r === from ? to : r));
}

/** コマの名前を変えたとき、その画像を使うシーン・プレハブの Sprite.frame（と、clipsOnly=false ならシートの動き）も書き換える */
function renameRefs(docs: Docs, image: string, from: string, to: string, changes: Change[], dirty: Set<string>, clipsDone: boolean): void {
  if (!clipsDone) {
    const sheet = docs.sheets.get(image);
    if (sheet) renameInClips(sheet, from, to);
  }
  const fix = (base: string, comps: Record<string, Record<string, unknown>>, dirtyKey: string) => {
    const sp = comps.Sprite;
    if (sp?.image === image && sp.frame === from) {
      sp.frame = to;
      changes.push({ path: `${base}.Sprite.frame`, from, to, auto: true });
      dirty.add(dirtyKey);
    }
  };
  for (const s of docs.scenes.values()) for (const e of s.entities) fix(`${s.name}#${e.id}`, e.components, `scene:${s.name}`);
  for (const p of docs.prefabs.values()) fix(`@${p.name}`, p.components, `prefab:${p.name}`);
}

const short = (v: unknown) => (Array.isArray(v) ? v.join(',') : v);

/** 2つのシートの違いを、コマ・動きの単位で求める */
export function diffSheet(image: string, a: SheetDef | undefined, b: SheetDef | undefined): Change[] {
  const out: Change[] = [];
  const at = (rest: string) => sheetAddress(image, rest);
  if (!a && !b) return out;
  if (!a) out.push({ path: sheetAddress(image), to: 'added' });
  if (!b) { out.push({ path: sheetAddress(image), from: a, to: 'removed' }); return out; }
  const grid = (s?: SheetDef) => (s?.frame ? `${s.frame.join('x')}${s.spacing ? ` 隙間${s.spacing}` : ''}${s.margin ? ` 余白${s.margin}` : ''}` : undefined);
  if (grid(a) !== grid(b)) out.push({ path: at('grid'), from: grid(a), to: grid(b) ?? 'removed' });
  const fa = new Map((a?.frames ?? []).map((f, i) => [f.name, { f, i }]));
  const fb = new Map((b.frames ?? []).map((f, i) => [f.name, { f, i }]));
  for (const [name, { f }] of fb) {
    const old = fa.get(name)?.f;
    if (!old) { out.push({ path: at(name), to: 'added' }); continue; }
    if (JSON.stringify(old.rect) !== JSON.stringify(f.rect)) out.push({ path: at(`${name}.rect`), from: short(old.rect), to: short(f.rect) });
    if (JSON.stringify(old.pivot) !== JSON.stringify(f.pivot)) out.push({ path: at(`${name}.pivot`), from: short(old.pivot), to: short(f.pivot) ?? 'removed' });
  }
  for (const [name, { f }] of fa) if (!fb.has(name)) out.push({ path: at(name), from: short(f.rect), to: 'removed' });
  const order = (s?: SheetDef) => (s?.frames ?? []).map((f) => f.name).filter((n) => fa.has(n) && fb.has(n)).join('\u0000');
  if (a?.frames && b.frames && order(a) !== order(b)) out.push({ path: at('order'), from: '並び', to: '並べ替え' });
  for (const name of new Set([...Object.keys(a?.clips ?? {}), ...Object.keys(b.clips ?? {})])) {
    const ca = a?.clips?.[name], cb = b.clips?.[name];
    if (!ca) { out.push({ path: at(`clip:${name}`), to: 'added' }); continue; }
    if (!cb) { out.push({ path: at(`clip:${name}`), from: ca, to: 'removed' }); continue; }
    for (const k of ['frames', 'fps', 'loop'] as const) {
      if (JSON.stringify(ca[k]) !== JSON.stringify(cb[k])) out.push({ path: at(`clip:${name}.${k}`), from: short(ca[k]), to: short(cb[k]) });
    }
  }
  return out;
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
  for (const image of new Set([...before.sheets.keys(), ...after.sheets.keys()])) out.push(...diffSheet(image, before.sheets.get(image), after.sheets.get(image)));
  for (const name of new Set([...before.tables.keys(), ...after.tables.keys()])) out.push(...diffTable(name, before.tables.get(name), after.tables.get(name)));
  return out;
}

/** 2つの表の違いを、行・セルの単位で求める */
export function diffTable(name: string, a: TableDoc | undefined, b: TableDoc | undefined): Change[] {
  const out: Change[] = [];
  const ra = new Map((a?.rows ?? []).map((r) => [r.id, r])), rb = new Map((b?.rows ?? []).map((r) => [r.id, r]));
  for (const [id, r] of rb) {
    const o = ra.get(id);
    if (!o) { out.push({ path: `$${name}.${id}`, to: 'added' }); continue; }
    for (const k of new Set([...Object.keys(o), ...Object.keys(r)])) {
      if (k === 'id') continue;
      if (JSON.stringify(o[k]) !== JSON.stringify(r[k])) out.push({ path: `$${name}.${id}.${k}`, from: o[k], to: r[k] });
    }
  }
  for (const [id, r] of ra) if (!rb.has(id)) out.push({ path: `$${name}.${id}`, from: r, to: 'removed' });
  const order = (t?: TableDoc) => (t?.rows ?? []).map((r) => r.id).filter((id) => ra.has(id) && rb.has(id)).join('\u0000');
  if (a && b && order(a) !== order(b)) out.push({ path: `$${name}`, from: '並び', to: '並べ替え' });
  return out;
}
