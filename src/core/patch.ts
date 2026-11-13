// 差分編集。AIも人（エディタ）も、ファイルの変更はすべてここを通る。
// 返り値は「何がいくつからいくつに変わったか」だけ。
import { formatSub, getIn, parseAddress, setIn, type Address, type EntityData, type PrefabChild, type PrefabDoc, type ProjectConfig, type SceneDoc } from './docs.ts';
import { checkAt, checkCell, defaultOf, filled, mapLeaves, suggest, type CellValue, type Field } from './schema.ts';
import { ROW_ID, type Row, type TableDoc } from './table.ts';
import type { Registry } from './registry.ts';
import { baseNameOf, checkSheet, findFrame, sheetPathOf, toExplicit, type FrameDef, type FrameRef, type SheetDef } from './sheet.ts';
import { frameMapper, remapRef } from './slice.ts';
import { assetRefs, checkAssetPath, extOf, isUnder, kindOf, leafRefs } from './assets.ts';
import { baseChain, childPrefabRefs, prefabChildren, prefabHolders, resolveEntity, resolvePrefab, childAt, CHILD_NAME } from './variant.ts';
import { same } from './revert.ts';

export type Op =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'addEntity'; scene: string; entity: { id: string; name?: string; prefab?: string; tags?: string[]; remove?: string[]; components?: Record<string, Record<string, unknown>> } }
  | { op: 'linkPrefab'; target: string; prefab: string | null }
  | { op: 'removeEntity'; scene: string; id: string }
  | { op: 'addComponent'; target: string; component: string; values?: Record<string, unknown> }
  | { op: 'removeComponent'; target: string; component: string }
  /**
   * UI を画面（親）の端・角に付ける。edge は anchor の名前（topRight など）、margin は端からの間(px。0 で接する)。
   * 隣に付けていた（beside）なら外す
   */
  | { op: 'dockUI'; target: string; edge: string; margin?: number }
  /**
   * UI を別の UI の隣に接して置く（重ならない。相手が動けば一緒に動く）。to は同じシーンの UI の ID。
   * side は right・left・below・above、gap は間(px。既定 0)、align は start・center・end（揃える所）
   */
  | { op: 'attachUI'; target: string; to: string; side?: string; gap?: number; align?: string }
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
  | { op: 'removeAsset'; path: string }
  /** シーンを作る（copy で、そのシーンの写し） */
  | { op: 'addScene'; name: string; copy?: string; desc?: string }
  /** シーンを消す（開始シーンと、使われているシーンは消せない） */
  | { op: 'removeScene'; name: string }
  /** シーンの名前を変える（scene 型の値と開始シーンも直る） */
  | { op: 'renameScene'; name: string; to: string }
  /** シーンの説明・開始シーンにする */
  | { op: 'setScene'; name: string; desc?: string; start?: boolean }
  /** プレハブを作る。base で派生（元を受け継ぐ。components には変える値だけ）、copy で中身の写し */
  | { op: 'addPrefab'; name: string; base?: string; copy?: string; desc?: string; tags?: string[]; components?: Record<string, Record<string, unknown>>; children?: PrefabChild[] }
  /** プレハブを消す（使われているもの・派生の元は消せない） */
  | { op: 'removePrefab'; name: string }
  /** プレハブの名前を変える（prefab 型の値・派生の元・🔒★の住所も直る） */
  | { op: 'renamePrefab'; name: string; to: string }
  /** プレハブの説明・タグ・派生の元（base: null で切り離す。値は今のまま） */
  | { op: 'setPrefab'; name: string; desc?: string; tags?: string[]; base?: string | null }
  /** 書いた値を消して、派生なら元の値に、そうでなければ既定値に戻す。派生では部品ごと（@x.部品）も */
  | { op: 'revert'; path: string };

/**
 * 操作（op）の書き方の一覧。ages schema <dir> ops で引く（毎回読む MCP の説明には並べない）。
 * Record にしてあるので、op を足して書き忘れると型の検査で止まる
 */
export const OP_DOCS: Record<Op['op'], string> = {
  set: '{path,value} 値を1つ変える',
  setCells: '{path,cells:[[行,列,値]]} 行列の一部のセルだけ変える（行列全体を送らない）',
  insert: '{path,value?,index?} リストに足す（path はリストの住所。index を省くと最後、value を省くと既定値）',
  removeItem: '{path:"…[2]"} リストから消す',
  moveItem: '{path:"…[2]",to} リストの中で動かす（to は動かした後の番号）',
  addEntity: '{scene,entity:{id,name?,prefab?,tags?,components?}} 物を足す。prefab でプレハブのインスタンス（つながり、components にはプレハブと違う値だけ書く）',
  linkPrefab: '{target,prefab|null} シーンの物をプレハブにつなぐ（違う値だけが物の値になる）・null で切り離す（今の値をまるごと持つ）。どちらも今の値は変わらない',
  removeEntity: '{scene,id} 物を消す',
  addComponent: '{target,component,values?} コンポーネントを付ける（target は main#player か @enemy）',
  removeComponent: '{target,component} コンポーネントを外す',
  rename: '{target,name} シーンの物の名前を変える（プレハブは renamePrefab）',
  addRow: '{table,row:{id,...},index?} 表に行を足す（省いた列は既定値）',
  removeRow: '{table,id} 表から行を消す',
  moveRow: '{table,id,to} 表の中で行を動かす',
  renameRow: '{table,id,to} 行の id を変える（その行を指している値も直る）',
  setSheet: '{image,sheet|null,renames?} 画像の切り方をまるごと決める・消す（ふつうは ages slice）',
  setFrame: '{image,frame(番号か名前),name?,rect?:[x,y,w,h],pivot?:[x,y]|null,remove?} コマを1つ変える。ない名前に rect で追加。名前を変えると参照も直る',
  setClip: '{image,clip,frames?,fps?,loop?,remove?} 動きを1つ変える・足す・消す',
  moveAsset: '{from,to} ファイルかフォルダの場所を変える（使っている値と切り方も直る）',
  removeAsset: '{path} ファイルかフォルダを消す（使っていないものだけ）',
  addScene: '{name,copy?,desc?} シーンを作る（copy でそのシーンの写し）',
  removeScene: '{name} シーンを消す（開始と、使われているものは消せない）',
  renameScene: '{name,to} シーンの名前を変える（scene 型の値と開始シーンも直る）',
  setScene: '{name,desc?,start?} シーンの説明・開始シーンにする',
  addPrefab: '{name,base?,copy?,desc?,tags?,components?,children?} プレハブを作る。base で派生（元を受け継ぎ、components には変える値だけ書く）、copy で中身をまるごと写す。children は子 [{name,prefab?,components,children?}]（guide:prefab）',
  removePrefab: '{name} プレハブを消す（使われているもの・派生の元は消せない）',
  renamePrefab: '{name,to} プレハブの名前を変える（prefab 型の値・派生の元・🔒★も直る。コードの中は直さない）',
  setPrefab: '{name,desc?,tags?,base?} 説明・タグ・派生の元を変える（base: null で切り離す。どちらも今の値は変わらない）',
  revert: '{path} 書いた値を消して、派生・インスタンスならプレハブ（元）の値に、そうでなければ既定値に戻す（@x.部品・シーン#ID.部品 で部品ごと）',
  dockUI: '{target,edge,margin?} UI を画面（親）の端・角に付ける。edge は topLeft top topRight left center right bottomLeft bottom bottomRight、margin は端からの間(px)。例 {"op":"dockUI","target":"main#hp","edge":"topRight","margin":8}',
  attachUI: '{target,to,side?,gap?,align?} UI を別の UI の隣に接して置く（重ならず、相手と一緒に動く）。side は right left below above、align は start center end。例 {"op":"attachUI","target":"main#lives","to":"hp","side":"below","gap":4}',
};

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
  /** 派生が元から受け継いでいる値で、元（@名前）の変更に合わせて変わったもの。ロックは効く */
  via?: string;
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
  /** プロジェクトの設定（開始シーンの変更で使う。dirty は "config"） */
  config?: ProjectConfig;
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
    if (a.child?.length) throw new Error(`@${a.doc}/${a.child.join('/')}: 子では値を変えるだけ（set）。部品の足し外し・子の足し引きは、プレハブを addPrefab の children で作り直す`);
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
  /** フィールドを持っているもの（コンポーネントの値・表の行）と、その型（隣の欄を直すとき用） */
  parent: Record<string, unknown>;
  siblings: Record<string, Field>;
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
    const rt = resolveParams(reg, top, row, at, a.sub);
    return { top: rt, topValue, isDefault: !has, sub: a.sub, ...walk(at, rt, topValue, a.sub), at, key: `table:${a.doc}`, parent: row, siblings: def.columns, write: (v) => { row[a.field!] = v; } };
  }
  if (!a.component || !a.field) throw new Error(`フィールドまでのアドレスが必要です（例: main#player.Mover.speed）。受け取った値: ${path}`);
  if (a.kind === 'prefab' && a.child?.length) return childSlot(docs, reg, a, path);
  const { holder, key } = holderOf(docs, a);
  const comp = holder.components[a.component];
  if (!comp) throw new Error(`${path}: コンポーネント ${a.component} が付いていません${suggest(a.component, Object.keys(holder.components))}`);
  const def = reg.component(a.component);
  const top = def.fields[a.field];
  if (!top) throw new Error(`${a.component} に ${a.field} はありません${suggest(a.field, Object.keys(def.fields))}`);
  const has = a.field in comp;
  const topValue = has ? comp[a.field] : defaultOf(top);
  const at = `${a.component}.${a.field}`;
  const rt = resolveParams(reg, top, comp, at, a.sub);
  return { top: rt, topValue, isDefault: !has, sub: a.sub, ...walk(at, rt, topValue, a.sub), at, key, parent: comp, siblings: def.fields, write: (v) => { comp[a.field!] = v; } };
}

/**
 * 子の値（@親/子.部品.欄）。読むのは元・子にしたプレハブと重ねた値、書くのはプレハブのファイルの子（なければ、変えた値の入れ物を作る）
 */
function childSlot(docs: Docs, reg: Registry, a: Address, path: string): Slot {
  const where = `@${a.doc}`;
  if (!docs.prefabs.has(a.doc)) throw new Error(`プレハブ ${a.doc} はありません${suggest(a.doc, [...docs.prefabs.keys()])}`);
  const resolved = childAt(prefabChildren(docs.prefabs, a.doc), a.child!, where);
  const rc = resolved.components[a.component!];
  if (!rc) throw new Error(`${path}: コンポーネント ${a.component} が付いていません${suggest(a.component!, Object.keys(resolved.components))}`);
  const def = reg.component(a.component!);
  const top = def.fields[a.field!];
  if (!top) throw new Error(`${a.component} に ${a.field} はありません${suggest(a.field!, Object.keys(def.fields))}`);
  /** ファイルの中の子（create なら、ない所は変えた値の入れ物を作る） */
  const rawNode = (create: boolean): PrefabChild | undefined => {
    let list: PrefabChild[] | undefined = docs.prefabs.get(a.doc)!.children, holder: { children?: PrefabChild[] } = docs.prefabs.get(a.doc)!;
    let node: PrefabChild | undefined;
    for (const seg of a.child!) {
      node = list?.find((c) => c.name === seg);
      if (!node) {
        if (!create) return undefined;
        node = { name: seg, components: {} };
        (holder.children ??= []).push(node);
      }
      holder = node;
      list = node.children;
    }
    return node;
  };
  const raw = rawNode(false)?.components?.[a.component!];
  const has = !!raw && a.field! in raw;
  const inherited = rc[a.field!];
  const topValue = has ? raw![a.field!] : inherited !== undefined ? inherited : defaultOf(top);
  const at = `${a.component}.${a.field}`;
  const rt = resolveParams(reg, top, rc, at, a.sub);
  return {
    top: rt, topValue, isDefault: inherited === undefined && !has, sub: a.sub, ...walk(at, rt, topValue, a.sub), at, key: `prefab:${a.doc}`, parent: rc, siblings: def.fields,
    write: (v) => { const n = rawNode(true)!; (n.components[a.component!] ??= {})[a.field!] = v; },
  };
}

/** シェーダーの値（params）は、隣の欄で選んだシェーダーの uniform を項目にした構造体として扱う */
function resolveParams(reg: Registry, f: Field, parent: Record<string, unknown>, at: string, sub: (string | number)[]): Field {
  if (f.type !== 'params') return f;
  const path = parent[f.of];
  const st = reg.shaderParams(path);
  if (st) return st;
  if (!sub.length) return f;
  throw new Error(path ? `${at}: ${f.of} のシェーダー ${path} がありません${suggest(String(path), [...reg.shaders.keys()])}` : `${at}: 先に ${f.of} でシェーダーを選んでください（例 std:flash）`);
}

/** シェーダーを変えたら、新しいシェーダーにない値は外す（意味を保つ自動の直し） */
function pruneParams(reg: Registry, sl: Slot, path: string, field: string, changes: Change[]): void {
  for (const [k, f] of Object.entries(sl.siblings)) {
    if (f.type !== 'params' || f.of !== field || !sl.parent[k] || typeof sl.parent[k] !== 'object') continue;
    const st = reg.shaderParams(sl.parent[field]);
    const cur = sl.parent[k] as Record<string, unknown>;
    const kept = Object.fromEntries(Object.entries(cur).filter(([n, v]) => st?.fields[n] && !checkAt(n, st.fields[n], v)));
    if (Object.keys(kept).length === Object.keys(cur).length) continue;
    changes.push({ path: path.replace(/\.[^.]+$/, `.${k}`), from: cur, to: kept });
    sl.parent[k] = kept;
  }
}

/** 値を読む。フィールドが省略されていれば既定値を返す（isDefault=true）。 */
export function getValue(docs: Docs, reg: Registry, path: string): { value: unknown; isDefault: boolean } {
  if (path.startsWith('@') || (path.includes('#') && !path.startsWith('$') && !path.startsWith('sheet:'))) docs = resolvedView(docs, path);
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
  const a = parseAddress(path);
  const raw = a.kind === 'prefab' ? docs.prefabs.get(a.doc) : undefined;
  if (raw?.base && a.component && a.field) {
    // 派生: 受け継いでいる値なら、元の値を写してから書く（変えた値になる）
    const comp = (raw.components[a.component] ??= {});
    if (!(a.field in comp)) {
      const inherited = resolvePrefab(docs.prefabs, a.doc).components[a.component]?.[a.field];
      if (inherited !== undefined) comp[a.field] = structuredClone(inherited);
    }
  }
  const ent = a.kind === 'scene' ? docs.scenes.get(a.doc)?.entities.find((e) => e.id === a.entity) : undefined;
  if (ent?.prefab && a.component && a.field) {
    // プレハブのインスタンス: プレハブから受け継いでいる値なら、プレハブの値を写してから書く（変えた値になる）
    const comp = (ent.components[a.component] ??= {});
    if (!(a.field in comp)) {
      const inherited = resolveEntity(docs.prefabs, { ...ent, components: {} }).components[a.component]?.[a.field];
      if (inherited !== undefined) comp[a.field] = structuredClone(inherited);
    }
  }
  const s = slotOf(docs, reg, a, path);
  s.write(setIn(s.topValue, s.sub, structuredClone(value)));
  return s.key;
}

/** 住所が派生のプレハブ・プレハブのインスタンスを指すなら、プレハブと重ねたものに差し替えた見え方（読むだけ） */
function resolvedView(docs: Docs, path: string): Docs {
  const a = parseAddress(path);
  if (a.kind === 'scene') {
    const sc = docs.scenes.get(a.doc);
    const i = sc?.entities.findIndex((e) => e.id === a.entity) ?? -1;
    if (!sc || i < 0 || !sc.entities[i].prefab) return docs;
    const entities = [...sc.entities];
    entities[i] = resolveEntity(docs.prefabs, entities[i]);
    return { ...docs, scenes: new Map(docs.scenes).set(a.doc, { ...sc, entities }) };
  }
  if (a.child?.length || !docs.prefabs.get(a.doc)?.base) return docs;
  return { ...docs, prefabs: new Map(docs.prefabs).set(a.doc, resolvePrefab(docs.prefabs, a.doc)) };
}

/** 操作をまとめて適用する。1つでも失敗したら何も変えない。 */
export function applyOps(docs: Docs, reg: Registry, ops: Op[]): PatchResult {
  const work: Docs = { scenes: structuredClone(docs.scenes), prefabs: structuredClone(docs.prefabs), sheets: structuredClone(docs.sheets), tables: structuredClone(docs.tables), files: docs.files && new Set(docs.files), config: docs.config && structuredClone(docs.config) };
  const changes: Change[] = [];
  const dirty = new Set<string>();
  const files: FileOp[] = [];
  // 派生のプレハブは、元と重ねた写しの上で操作し、終わってから「変えたフィールドだけ」を書き戻す（どの操作もそのまま派生に使える）
  const track = new VariantTrack(work);
  for (const p of [...work.prefabs.values()]) if (p.base) track.add(p.name);
  // シーンに置いたプレハブのインスタンスも同じ: プレハブと重ねた写しの上で操作し、終わってから「プレハブと違う値だけ」を書き戻す
  const itrack = new InstanceTrack(work);
  itrack.addAll();
  ops.forEach((op, i) => {
    try {
      if (op.op === 'moveAsset' || op.op === 'removeAsset') assetOp(work, reg, op, changes, dirty, files);
      else if (op.op === 'addScene' || op.op === 'removeScene' || op.op === 'renameScene' || op.op === 'setScene') sceneOp(work, reg, op, changes, dirty, itrack);
      else if (op.op === 'addPrefab' || op.op === 'removePrefab' || op.op === 'renamePrefab' || op.op === 'setPrefab' || op.op === 'revert') prefabOp(work, reg, op, changes, dirty, track, itrack);
      else if (op.op === 'linkPrefab') linkPrefab(work, reg, op, changes, dirty, itrack);
      else applyOne(work, reg, op, changes, dirty, itrack);
    } catch (err) {
      throw new PatchError(i, err instanceof Error ? err.message : String(err));
    }
  });
  try {
    track.writeBack(dirty);
    track.inherited(changes);
    itrack.writeBack(dirty);
    itrack.inherited(changes);
  } catch (err) {
    throw new PatchError(ops.length - 1, err instanceof Error ? err.message : String(err));
  }
  // 成功したら本物に反映
  for (const k of dirty) {
    if (k === 'config') { if (docs.config && work.config) Object.assign(docs.config, work.config); continue; }
    const i = k.indexOf(':');
    const kind = k.slice(0, i), name = k.slice(i + 1);
    if (kind === 'scene') { if (work.scenes.has(name)) docs.scenes.set(name, work.scenes.get(name)!); else docs.scenes.delete(name); }
    else if (kind === 'prefab') { if (work.prefabs.has(name)) docs.prefabs.set(name, work.prefabs.get(name)!); else docs.prefabs.delete(name); }
    else if (kind === 'table') docs.tables.set(name, work.tables.get(name)!);
    else if (work.sheets.has(name)) docs.sheets.set(name, work.sheets.get(name)!);
    else docs.sheets.delete(name);
  }
  if (files.length && docs.files && work.files) { docs.files.clear(); for (const f of work.files) docs.files.add(f); }
  return { changes, dirty, files };
}

function applyOne(docs: Docs, reg: Registry, op: Op, changes: Change[], dirty: Set<string>, itrack?: InstanceTrack): void {
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
      if (sl.field.type === 'asset' && sl.field.kind === 'shader' && !sl.sub.length) pruneParams(reg, sl, op.path, parseAddress(op.path).field!, changes);
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
      const pf = op.entity.prefab;
      if (pf !== undefined && (typeof pf !== 'string' || !docs.prefabs.has(pf))) throw new Error(`プレハブ ${pf} はありません${suggest(String(pf), [...docs.prefabs.keys()])}`);
      // プレハブのインスタンス: プレハブとつながり、components にはプレハブと違う値だけを書く（プレハブと重ねて検証する）
      const e: EntityData = pf ? { id: op.entity.id, name: op.entity.name ?? op.entity.id, prefab: pf, ...(op.entity.remove?.length ? { remove: [...op.entity.remove] } : {}), components: structuredClone(comps) } : { id: op.entity.id, name: op.entity.name ?? op.entity.id, components: structuredClone(comps) };
      for (const [name, values] of Object.entries(pf ? resolveEntity(docs.prefabs, e).components : comps)) reg.build(name, values, `${op.scene}#${op.entity.id}`);
      if (op.entity.tags?.length) e.tags = [...op.entity.tags];
      s.entities.push(e);
      if (pf) itrack?.add(op.scene, e.id, true);
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
    case 'dockUI':
    case 'attachUI': {
      const a = parseAddress(op.target);
      const { holder } = holderOf(docs, a);
      const u = holder.components.UI;
      if (!u) throw new Error(`${op.target} に UI が付いていません（画面に固定する物にだけ使えます）`);
      // Layout で並べている子は、並びで位置が決まる
      if (a.kind === 'scene' && u.parent) {
        const p = docs.scenes.get(a.doc)!.entities.find((x) => x.id === u.parent);
        if (p?.components.Layout) throw new Error(`${op.target} は ${u.parent} の Layout で並べています。位置を変えるなら ${u.parent} を動かすか、UI.order で並び順を変えてください`);
      }
      const set = (field: string, value: unknown) => applyOne(docs, reg, { op: 'set', path: `${op.target}.UI.${field}`, value }, changes, dirty);
      if (op.op === 'dockUI') {
        const edges = ['topLeft', 'top', 'topRight', 'left', 'center', 'right', 'bottomLeft', 'bottom', 'bottomRight'];
        if (!edges.includes(op.edge)) throw new Error(`dockUI: edge は ${edges.join(' | ')} のどれかです${suggest(String(op.edge), edges)}`);
        const m = op.margin ?? 0;
        const i = edges.indexOf(op.edge);
        // 端から内側へ margin だけ（左・上の端は +、右・下の端は −、真ん中は 0）
        const sx = [1, 0, -1][i % 3], sy = [1, 0, -1][Math.floor(i / 3)];
        set('anchor', op.edge);
        set('x', sx * m);
        set('y', sy * m);
        if (u.beside) set('beside', null);
        return;
      }
      const to = op.to.includes('#') ? op.to.slice(op.to.indexOf('#') + 1) : op.to;
      if (a.kind === 'scene') {
        const ents = docs.scenes.get(a.doc)!.entities;
        const other = ents.find((x) => x.id === to);
        if (!other) throw new Error(`attachUI: シーン ${a.doc} に ${to} はありません${suggest(to, ents.filter((x) => x.components.UI).map((x) => x.id))}`);
        if (!other.components.UI) throw new Error(`attachUI: ${to} に UI が付いていません（隣に付けられるのは UI の物だけ）`);
        if (to === a.entity) throw new Error('attachUI: 自分の隣には付けられません');
        // 相手をたどって自分に戻るなら輪になる
        for (let cur: string | null = to, n = 0; cur && n < ents.length; n++) {
          if (cur === a.entity) throw new Error(`attachUI: ${to} は（たどると）${a.entity} の隣に付いているので、輪になります`);
          cur = (ents.find((x) => x.id === cur)?.components.UI?.beside as string | null | undefined) ?? null;
        }
      }
      set('beside', to);
      set('side', op.side ?? 'right');
      set('gap', op.gap ?? 0);
      set('align', op.align ?? 'start');
      set('x', 0);
      set('y', 0);
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
      // プレハブの名前はファイルの名前で、指している所もある。name を書き換えるだけだと、ファイルと参照がずれる
      if (a.kind === 'prefab') throw new Error(`プレハブの名前は renamePrefab で変えます（{"op":"renamePrefab","name":"${a.doc}","to":"${op.name}"}。ファイルの名前と、指している所も直る）。rename はシーンの物の名前`);
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
      throw new Error(`未知の操作 ${(op as { op: string }).op}${suggest(String((op as { op: string }).op), Object.keys(OP_DOCS))}。一覧と書き方は ages schema <dir> ops`);
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
  for (const p of docs.prefabs.values()) for (const [at, comps] of prefabHolders(p)) fixHolder(at, comps, `prefab:${p.name}`);
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

const SCENE_NAME = /^[A-Za-z0-9_-]+$/;

/** シーンを作る・消す・名前を変える・説明と開始シーン */
function sceneOp(docs: Docs, reg: Registry, op: Extract<Op, { op: 'addScene' | 'removeScene' | 'renameScene' | 'setScene' }>, changes: Change[], dirty: Set<string>, itrack?: InstanceTrack): void {
  const need = (name: string) => {
    const s = docs.scenes.get(name);
    if (!s) throw new Error(`シーン ${name} はありません${suggest(String(name), [...docs.scenes.keys()])}`);
    return s;
  };
  const fresh = (name: string) => {
    if (typeof name !== 'string' || !SCENE_NAME.test(name)) throw new Error(`シーンの名前 "${name}" には英数字・_・- だけが使えます`);
    if (docs.scenes.has(name)) throw new Error(`シーン ${name} はすでにあります`);
  };
  const usedBy = (name: string) => leafRefs(docs, reg, (f) => f.type === 'scene').get(name) ?? [];
  switch (op.op) {
    case 'addScene': {
      fresh(op.name);
      const entities = op.copy ? structuredClone(need(op.copy).entities) : [];
      docs.scenes.set(op.name, { name: op.name, ...(op.desc ? { desc: op.desc } : {}), entities });
      // 写したインスタンスは、写し元と同じようにプレハブとつながったまま（プレハブと違う値だけを書く）
      if (op.copy) itrack?.copyScene(op.copy, op.name);
      dirty.add(`scene:${op.name}`);
      changes.push({ path: `scene:${op.name}`, to: 'added' });
      return;
    }
    case 'removeScene': {
      need(op.name);
      if (docs.config?.startScene === op.name) throw new Error(`${op.name} は開始シーンなので消せません。先に別のシーンを開始にしてください（setScene の start）`);
      const used = usedBy(op.name);
      if (used.length) throw new Error(`シーン ${op.name} は使われているので消せません: ${used.slice(0, 5).join(', ')}。先にその指定を変えてください`);
      docs.scenes.delete(op.name);
      dirty.add(`scene:${op.name}`);
      changes.push({ path: `scene:${op.name}`, to: 'removed' });
      return;
    }
    case 'renameScene': {
      const s = need(op.name);
      if (op.to === op.name) return;
      fresh(op.to);
      docs.scenes.delete(op.name);
      s.name = op.to;
      docs.scenes.set(op.to, s);
      itrack?.renameScene(op.name, op.to);
      dirty.add(`scene:${op.name}`);
      dirty.add(`scene:${op.to}`);
      changes.push({ path: `scene:${op.name}`, from: op.name, to: `renamed:${op.to}` });
      if (docs.config?.startScene === op.name) {
        docs.config.startScene = op.to;
        dirty.add('config');
        changes.push({ path: 'config.startScene', from: op.name, to: op.to, auto: true });
      }
      fixLeaves(docs, reg, (f, v) => (f.type === 'scene' && v === op.name ? op.to : undefined), changes, dirty);
      return;
    }
    case 'setScene': {
      const s = need(op.name);
      if (op.desc !== undefined) {
        if (typeof op.desc !== 'string') throw new Error('setScene の desc は文字列です');
        const from = s.desc ?? '';
        if (from !== op.desc) {
          // 名前・説明・物の順に並べる（ファイルが読みやすいように）
          docs.scenes.set(op.name, { name: s.name, ...(op.desc ? { desc: op.desc } : {}), entities: s.entities });
          dirty.add(`scene:${op.name}`);
          changes.push({ path: `scene:${op.name}.desc`, from, to: op.desc });
        }
      }
      if (op.start) {
        if (!docs.config) throw new Error('開始シーンを変えるにはプロジェクトの設定が必要です');
        if (docs.config.startScene !== op.name) {
          changes.push({ path: 'config.startScene', from: docs.config.startScene, to: op.name });
          docs.config.startScene = op.name;
          dirty.add('config');
        }
      }
      return;
    }
  }
}

const PREFAB_NAME = /^[A-Za-z0-9_-]+$/;

interface Tracked {
  /** 操作の前の名前 */
  orig: string;
  /** 操作の前の、元と重ねた写し */
  before: PrefabDoc;
  /** 操作の前のファイルの中身（元からの差） */
  raw: PrefabDoc;
  isNew: boolean;
}

/** 派生のプレハブを、操作のあいだだけ元と重ねた写しにしておく */
class VariantTrack {
  private docs: Docs;
  readonly items = new Map<string, Tracked>();
  constructor(docs: Docs) {
    this.docs = docs;
  }

  /** 派生を、元と重ねた写しに置き換える（base・remove は印として残す） */
  add(name: string, isNew = false): void {
    const raw = this.docs.prefabs.get(name)!;
    let resolved: PrefabDoc;
    try { resolved = resolvePrefab(this.docs.prefabs, name); } catch { return; } // 元がない・輪: そのまま（検証で知らせる）
    const copy: PrefabDoc = { name, base: raw.base, ...(resolved.desc ? { desc: resolved.desc } : {}), ...(resolved.tags ? { tags: [...resolved.tags] } : {}), ...(raw.remove ? { remove: [...raw.remove] } : {}), components: structuredClone(resolved.components), ...(raw.children ? { children: structuredClone(raw.children) } : {}) };
    this.docs.prefabs.set(name, copy);
    this.items.set(name, { orig: name, before: structuredClone(copy), raw: structuredClone(raw), isNew });
  }

  rename(from: string, to: string): void {
    const t = this.items.get(from);
    if (!t) return;
    this.items.delete(from);
    this.items.set(to, t);
  }

  drop(name: string): void {
    this.items.delete(name);
  }

  /** 写しを、元からの差（変えた値・足した部品・外した部品）に戻す。元に近いものから */
  writeBack(dirty: Set<string>): void {
    const depth = (n: string) => { try { return baseChain(this.docs.prefabs, n).length; } catch { return 0; } };
    for (const n of [...this.items.keys()].sort((a, b) => depth(a) - depth(b))) {
      const t = this.items.get(n)!;
      const after = this.docs.prefabs.get(n);
      if (!after?.base) continue;
      const raw = diffBack(t, after, resolvePrefab(this.docs.prefabs, after.base));
      const changed = t.isNew || n !== t.orig || !same(raw, t.raw);
      this.docs.prefabs.set(n, changed ? raw : t.raw);
      if (changed) dirty.add(`prefab:${n}`);
      else dirty.delete(`prefab:${n}`);
    }
  }

  /** 元の変更で変わった、派生が受け継いでいる値を、変更の一覧に足す（ロックの検査と記録のため） */
  inherited(changes: Change[]): void {
    const covered = (path: string) => changes.some((c) => c.path === path || path.startsWith(c.path + '.') || path.startsWith(c.path + '['));
    for (const [n, t] of this.items) {
      const raw = this.docs.prefabs.get(n);
      if (t.isNew || !raw?.base) continue;
      let now: PrefabDoc;
      try { now = resolvePrefab(this.docs.prefabs, n); } catch { continue; }
      const via = '@' + raw.base;
      for (const c of new Set([...Object.keys(t.before.components), ...Object.keys(now.components)])) {
        const b = t.before.components[c], a = now.components[c], at = `@${n}.${c}`;
        if (!a || !b) {
          if (a !== b && !covered(at) && !changes.some((x) => x.path.startsWith(at + '.'))) changes.push({ path: at, ...(b ? { from: b } : {}), to: a ? 'added' : 'removed', auto: true, via });
          continue;
        }
        for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
          if (!same(b[k], a[k]) && !covered(`${at}.${k}`)) changes.push({ path: `${at}.${k}`, from: b[k], to: a[k], auto: true, via });
        }
      }
    }
  }
}

/** 元と重ねた写し（after）を、元（base）からの差に戻す。操作の前と比べて変わったフィールドだけを書き換える */
function diffBack(t: Tracked, after: PrefabDoc, base: PrefabDoc): PrefabDoc {
  const before = t.before;
  const comps = structuredClone(t.raw.components ?? {});
  const remove = new Set(t.raw.remove ?? []);
  for (const c of new Set([...Object.keys(before.components), ...Object.keys(after.components)])) {
    const b = before.components[c], a = after.components[c], bc = base.components[c];
    if (!a) {
      if (b) { delete comps[c]; if (bc) remove.add(c); }
      continue;
    }
    if (!b) remove.delete(c);
    if (!bc) {
      // 元にない部品（派生で足したもの）は中身をそのまま書く
      if (!b || !same(a, b)) comps[c] = structuredClone(a);
      continue;
    }
    const own = comps[c] ?? {};
    for (const k of new Set([...Object.keys(b ?? {}), ...Object.keys(a)])) {
      if (b && same(b[k], a[k])) continue;
      // 元と同じ値になったものは「受け継ぐ」に戻す
      if (!(k in a) || same(a[k], bc[k])) delete own[k];
      else own[k] = structuredClone(a[k]);
    }
    if (Object.keys(own).length) comps[c] = own;
    else delete comps[c];
  }
  const desc = before.desc !== after.desc ? (after.desc && after.desc !== base.desc ? after.desc : undefined) : t.raw.desc;
  const tags = !same(before.tags, after.tags) ? (after.tags && !same(after.tags, base.tags) ? after.tags : undefined) : t.raw.tags;
  // 子は、元の子に重ねる値（書いてある形）のまま持っているので、そのまま
  const kids = after.children?.filter((c) => Object.keys(c.components ?? {}).length || c.children?.length || c.remove?.length);
  return { name: after.name, base: after.base, ...(desc ? { desc } : {}), ...(tags ? { tags } : {}), ...(remove.size ? { remove: [...remove] } : {}), components: comps, ...(kids?.length ? { children: kids } : {}) };
}

interface TrackedEntity {
  scene: string;
  id: string;
  /** 操作の前の、プレハブと重ねた写し */
  before: EntityData;
  /** 操作の前のファイルの中身（プレハブとの差） */
  raw: EntityData;
  isNew: boolean;
}

/** シーンに置いたプレハブのインスタンスを、操作のあいだだけプレハブと重ねた写しにしておく（VariantTrack と同じやり方） */
class InstanceTrack {
  private docs: Docs;
  readonly items = new Map<string, TrackedEntity>();
  constructor(docs: Docs) {
    this.docs = docs;
  }

  addAll(): void {
    for (const sc of this.docs.scenes.values()) for (const e of sc.entities) if (e.prefab) this.add(sc.name, e.id);
  }

  /** インスタンスを、プレハブと重ねた写しに置き換える（prefab・remove は印として残す） */
  add(scene: string, id: string, isNew = false): void {
    const sc = this.docs.scenes.get(scene);
    const i = sc?.entities.findIndex((e) => e.id === id) ?? -1;
    if (!sc || i < 0) return;
    const raw = sc.entities[i];
    let resolved: EntityData;
    try { resolved = resolveEntity(this.docs.prefabs, raw); } catch { return; } // プレハブがない: そのまま（検証で知らせる）
    const copy: EntityData = { id: raw.id, name: raw.name, prefab: raw.prefab, ...(resolved.tags ? { tags: [...resolved.tags] } : {}), ...(raw.remove ? { remove: [...raw.remove] } : {}), components: structuredClone(resolved.components) };
    sc.entities[i] = copy;
    this.items.set(`${scene}#${id}`, { scene, id, before: structuredClone(copy), raw: structuredClone(raw), isNew });
  }

  drop(scene: string, id: string): void {
    this.items.delete(`${scene}#${id}`);
  }

  copyScene(from: string, to: string): void {
    for (const t of [...this.items.values()].filter((x) => x.scene === from)) this.items.set(`${to}#${t.id}`, { ...structuredClone(t), scene: to, isNew: true });
  }

  renameScene(from: string, to: string): void {
    for (const [k, t] of [...this.items]) if (t.scene === from) { this.items.delete(k); this.items.set(`${to}#${t.id}`, { ...t, scene: to }); }
  }

  renamePrefab(from: string, to: string): void {
    for (const t of this.items.values()) if (t.raw.prefab === from) t.raw = { ...t.raw, prefab: to };
  }

  /** 写しを、プレハブとの差（変えた値・足した部品・外した部品）に戻す。派生を書き戻した後に呼ぶ */
  writeBack(dirty: Set<string>): void {
    for (const t of this.items.values()) {
      const sc = this.docs.scenes.get(t.scene);
      const i = sc?.entities.findIndex((e) => e.id === t.id) ?? -1;
      if (!sc || i < 0) continue;
      const after = sc.entities[i];
      if (!after.prefab) continue; // 切り離した（linkPrefab null）: 今の値をまるごと持つ
      let base: PrefabDoc;
      try { base = resolvePrefab(this.docs.prefabs, after.prefab); } catch { continue; }
      const raw = diffEntity(t, after, base);
      const changed = t.isNew || !same(raw, t.raw);
      sc.entities[i] = changed ? raw : t.raw;
      if (changed) dirty.add(`scene:${t.scene}`);
    }
  }

  /** プレハブの変更で変わった、インスタンスが受け継いでいる値を、変更の一覧に足す（ロックの検査と記録のため） */
  inherited(changes: Change[]): void {
    const covered = (path: string) => changes.some((c) => c.path === path || path.startsWith(c.path + '.') || path.startsWith(c.path + '['));
    for (const t of this.items.values()) {
      if (t.isNew) continue;
      const raw = this.docs.scenes.get(t.scene)?.entities.find((e) => e.id === t.id);
      if (!raw?.prefab) continue;
      let now: EntityData;
      try { now = resolveEntity(this.docs.prefabs, raw); } catch { continue; }
      const via = '@' + raw.prefab;
      for (const c of new Set([...Object.keys(t.before.components), ...Object.keys(now.components)])) {
        const b = t.before.components[c], a = now.components[c], at = `${t.scene}#${t.id}.${c}`;
        if (!a || !b) {
          if (a !== b && !covered(at) && !changes.some((x) => x.path.startsWith(at + '.'))) changes.push({ path: at, ...(b ? { from: b } : {}), to: a ? 'added' : 'removed', auto: true, via });
          continue;
        }
        for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
          if (!same(b[k], a[k]) && !covered(`${at}.${k}`)) changes.push({ path: `${at}.${k}`, from: b[k], to: a[k], auto: true, via });
        }
      }
    }
  }
}

/** プレハブと重ねた写し（after）を、プレハブ（base）との差に戻す（diffBack と同じ決まり） */
function diffEntity(t: TrackedEntity, after: EntityData, base: PrefabDoc): EntityData {
  const asPrefab = (e: EntityData): PrefabDoc => ({ name: e.id, base: e.prefab, ...(e.tags ? { tags: e.tags } : {}), ...(e.remove ? { remove: e.remove } : {}), components: e.components });
  const d = diffBack({ orig: t.id, before: asPrefab(t.before), raw: asPrefab(t.raw), isNew: t.isNew }, asPrefab(after), base);
  return { id: after.id, name: after.name, prefab: after.prefab, ...(d.tags ? { tags: d.tags } : {}), ...(d.remove ? { remove: d.remove } : {}), components: d.components };
}

/** シーンの物をプレハブにつなぐ・切り離す。どちらも、今の中身（重ねた値）は変えない */
function linkPrefab(docs: Docs, reg: Registry, op: Extract<Op, { op: 'linkPrefab' }>, changes: Change[], dirty: Set<string>, itrack: InstanceTrack): void {
  const a = parseAddress(op.target);
  if (a.kind !== 'scene' || !a.entity || a.component) throw new Error(`linkPrefab の target はシーンの物です（例 main#enemy1）。受け取った値: ${op.target}`);
  const sc = docs.scenes.get(a.doc);
  if (!sc) throw new Error(`シーン ${a.doc} はありません${suggest(a.doc, [...docs.scenes.keys()])}`);
  const i = sc.entities.findIndex((e) => e.id === a.entity);
  if (i < 0) throw new Error(`シーン ${a.doc} に ${a.entity} はありません${suggest(a.entity, sc.entities.map((e) => e.id))}`);
  const now = sc.entities[i]; // インスタンスなら、すでにプレハブと重ねた写し
  if ((now.prefab ?? null) === op.prefab) return;
  const from = now.prefab ?? null;
  if (op.prefab === null) {
    const e: EntityData = { id: now.id, name: now.name, ...(now.tags ? { tags: [...now.tags] } : {}), components: structuredClone(now.components) };
    sc.entities[i] = e;
    itrack.drop(a.doc, now.id);
  } else {
    if (typeof op.prefab !== 'string' || !docs.prefabs.has(op.prefab)) throw new Error(`プレハブ ${op.prefab} はありません${suggest(String(op.prefab), [...docs.prefabs.keys()])}`);
    const b = resolvePrefab(docs.prefabs, op.prefab);
    const comps: Record<string, Record<string, unknown>> = {};
    for (const [c, v] of Object.entries(now.components)) {
      const bc = b.components[c];
      if (!bc) { comps[c] = structuredClone(v); continue; }
      const own: Record<string, unknown> = {};
      for (const k of Object.keys(v)) if (!same(v[k], bc[k])) own[k] = structuredClone(v[k]);
      if (Object.keys(own).length) comps[c] = own;
    }
    const remove = Object.keys(b.components).filter((c) => !now.components[c]);
    const tags = now.tags && !same(now.tags, b.tags) ? [...now.tags] : undefined;
    sc.entities[i] = { id: now.id, name: now.name, prefab: op.prefab, ...(tags ? { tags } : {}), ...(remove.length ? { remove } : {}), components: comps };
    itrack.drop(a.doc, now.id);
    itrack.add(a.doc, now.id, true);
  }
  dirty.add(`scene:${a.doc}`);
  changes.push({ path: `${op.target}.prefab`, from, to: op.prefab });
}

/** プレハブを作る・消す・名前を変える・説明と派生の元、書いた値を戻す */
function prefabOp(docs: Docs, reg: Registry, op: Extract<Op, { op: 'addPrefab' | 'removePrefab' | 'renamePrefab' | 'setPrefab' | 'revert' }>, changes: Change[], dirty: Set<string>, track: VariantTrack, itrack?: InstanceTrack): void {
  const need = (name: string) => {
    const p = docs.prefabs.get(name);
    if (!p) throw new Error(`プレハブ ${name} はありません${suggest(String(name), [...docs.prefabs.keys()])}`);
    return p;
  };
  const fresh = (name: string) => {
    if (typeof name !== 'string' || !PREFAB_NAME.test(name)) throw new Error(`プレハブの名前 "${name}" には英数字・_・- だけが使えます`);
    if (docs.prefabs.has(name)) throw new Error(`プレハブ ${name} はすでにあります`);
  };
  const checkComps = (where: string, comps: Record<string, Record<string, unknown>>) => {
    if (!comps || typeof comps !== 'object') throw new Error(`${where}: components は { 部品: { 値 } } の形です`);
    for (const [c, v] of Object.entries(comps)) reg.build(c, v ?? {}, where);
  };
  /** 子の並びの形を確かめる（名前・重なり・子にしたプレハブ・部品の値） */
  const checkChildren = (where: string, list: unknown): PrefabChild[] => {
    if (!Array.isArray(list)) throw new Error(`${where}: children は [{ name, prefab?, components, children? }] の並びです`);
    const names = new Set<string>();
    for (const c of list as PrefabChild[]) {
      if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !CHILD_NAME.test(c.name)) throw new Error(`${where}: 子の名前 "${(c as PrefabChild)?.name}" には英数字・_・- だけが使えます`);
      if (names.has(c.name)) throw new Error(`${where}: 子の名前 ${c.name} が重なっています`);
      names.add(c.name);
      const at = `${where}/${c.name}`;
      if (c.prefab !== undefined) need(c.prefab);
      c.components ??= {};
      if (c.prefab) for (const [k, v] of Object.entries(c.components)) { if (!reg.components.has(k)) reg.build(k, v ?? {}, at); }
      else checkComps(at, c.components);
      if (c.children !== undefined) checkChildren(at, c.children);
    }
    return list as PrefabChild[];
  };
  // 子にしているプレハブ（@親/子）
  const asChild = (name: string) => [...docs.prefabs.values()].flatMap((p) => childPrefabRefs(p).filter((r) => r.node.prefab === name).map((r) => ({ p, ...r })));
  const derived = (name: string) => [...docs.prefabs.values()].filter((p) => p.base === name).map((p) => p.name);
  // シーンに置いたインスタンス（シーン#ID）
  const instances = (name: string) => [...docs.scenes.values()].flatMap((sc) => sc.entities.filter((e) => e.prefab === name).map((e) => ({ sc, e })));
  // 既定値でプレハブを指している所（書いていないので値の検索には出ない。例 Spawner.prefab の既定 "enemy"）
  const byDefault = (name: string) => {
    const out: { at: string; comp: Record<string, unknown>; field: string; key: string }[] = [];
    const scan = (base: string, comps: Record<string, Record<string, unknown>>, key: string) => {
      for (const [c, v] of Object.entries(comps)) {
        for (const [k, f] of Object.entries(reg.components.get(c)?.fields ?? {})) if (f.type === 'prefab' && !(k in v) && f.default === name) out.push({ at: `${base}.${c}.${k}`, comp: v, field: k, key });
      }
    };
    for (const sc of docs.scenes.values()) for (const e of sc.entities) scan(`${sc.name}#${e.id}`, e.components, `scene:${sc.name}`);
    for (const p of docs.prefabs.values()) for (const [at, comps] of prefabHolders(p)) scan(at, comps, `prefab:${p.name}`);
    return out;
  };
  const order = (p: PrefabDoc): PrefabDoc => ({ name: p.name, ...(p.base ? { base: p.base } : {}), ...(p.desc ? { desc: p.desc } : {}), ...(p.tags?.length ? { tags: p.tags } : {}), ...(p.remove?.length ? { remove: p.remove } : {}), components: p.components, ...(p.children?.length ? { children: p.children } : {}) });
  switch (op.op) {
    case 'addPrefab': {
      fresh(op.name);
      if (op.base && op.copy) throw new Error('addPrefab: base（派生）と copy（写し）は、どちらか1つです');
      if (op.tags !== undefined && (!Array.isArray(op.tags) || op.tags.some((t) => typeof t !== 'string'))) throw new Error('addPrefab の tags は文字列の配列です');
      const comps = structuredClone(op.components ?? {});
      checkComps(`@${op.name}`, comps);
      const kids = op.children === undefined ? undefined : checkChildren(`@${op.name}`, structuredClone(op.children));
      if (op.base) {
        need(op.base);
        docs.prefabs.set(op.name, order({ name: op.name, base: op.base, components: {} }));
        track.add(op.name, true);
        const copy = docs.prefabs.get(op.name)!;
        for (const [c, v] of Object.entries(comps)) copy.components[c] = { ...(copy.components[c] ?? {}), ...v };
        if (op.desc) copy.desc = op.desc;
        if (op.tags) copy.tags = op.tags;
        if (kids) copy.children = kids;
      } else {
        const src = op.copy ? need(op.copy) : undefined;
        docs.prefabs.set(op.name, order({ name: op.name, desc: op.desc ?? src?.desc, tags: op.tags ?? (src?.tags && [...src.tags]), components: { ...structuredClone(src?.components ?? {}), ...comps } }));
      }
      if (!op.base) {
        const made = docs.prefabs.get(op.name)!;
        const ch = kids ?? (op.copy ? structuredClone(need(op.copy).children) : undefined);
        if (ch?.length) docs.prefabs.set(op.name, order({ ...made, children: ch }));
      }
      // 子にしたプレハブ・子の名前・元の子との重ね方を、出す形にして確かめる（輪・ない子・ないプレハブ）
      prefabChildren(docs.prefabs, op.name);
      dirty.add(`prefab:${op.name}`);
      changes.push({ path: `prefab:${op.name}`, to: 'added' });
      return;
    }
    case 'removePrefab': {
      need(op.name);
      const used = [...(leafRefs(docs, reg, (f) => f.type === 'prefab').get(op.name) ?? []), ...asChild(op.name).map((r) => `${r.at}（子）`), ...byDefault(op.name).map((d) => `${d.at}（既定値）`), ...derived(op.name).map((n) => `@${n}（派生の元）`), ...instances(op.name).map(({ sc, e }) => `${sc.name}#${e.id}（インスタンス）`)];
      if (used.length) throw new Error(`プレハブ ${op.name} は使われているので消せません: ${used.slice(0, 5).join(', ')}${used.length > 5 ? ' …' : ''}。先にその指定を変えてください`);
      docs.prefabs.delete(op.name);
      track.drop(op.name);
      dirty.add(`prefab:${op.name}`);
      changes.push({ path: `prefab:${op.name}`, to: 'removed' });
      return;
    }
    case 'renamePrefab': {
      const p = need(op.name);
      fresh(op.to);
      // 既定値で指している所は、新しい名前を書いておく
      for (const d of byDefault(op.name)) {
        d.comp[d.field] = op.to;
        dirty.add(d.key);
        changes.push({ path: d.at, from: op.name, to: op.to, auto: true });
      }
      docs.prefabs.delete(op.name);
      docs.prefabs.set(op.to, { ...p, name: op.to });
      track.rename(op.name, op.to);
      dirty.add(`prefab:${op.name}`);
      dirty.add(`prefab:${op.to}`);
      changes.push({ path: `prefab:${op.name}`, from: op.name, to: `renamed:${op.to}` });
      for (const r of asChild(op.name)) {
        r.node.prefab = op.to;
        dirty.add(`prefab:${r.p.name}`);
        changes.push({ path: `${r.at}.prefab`, from: op.name, to: op.to, auto: true });
      }
      for (const d of derived(op.name)) {
        docs.prefabs.get(d)!.base = op.to;
        dirty.add(`prefab:${d}`);
        changes.push({ path: `prefab:${d}.base`, from: op.name, to: op.to, auto: true });
      }
      for (const { sc, e } of instances(op.name)) {
        e.prefab = op.to;
        dirty.add(`scene:${sc.name}`);
        changes.push({ path: `${sc.name}#${e.id}.prefab`, from: op.name, to: op.to, auto: true });
      }
      itrack?.renamePrefab(op.name, op.to);
      fixLeaves(docs, reg, (f, v) => (f.type === 'prefab' && v === op.name ? op.to : undefined), changes, dirty);
      return;
    }
    case 'setPrefab': {
      const p = need(op.name);
      if (op.desc !== undefined) {
        if (typeof op.desc !== 'string') throw new Error('setPrefab の desc は文字列です');
        if ((p.desc ?? '') !== op.desc) {
          changes.push({ path: `prefab:${op.name}.desc`, from: p.desc ?? '', to: op.desc });
          if (op.desc) p.desc = op.desc; else delete p.desc;
          dirty.add(`prefab:${op.name}`);
        }
      }
      if (op.tags !== undefined) {
        if (!Array.isArray(op.tags) || op.tags.some((t) => typeof t !== 'string')) throw new Error('setPrefab の tags は文字列の配列です');
        if (!same(p.tags ?? [], op.tags)) {
          changes.push({ path: `prefab:${op.name}.tags`, from: p.tags ?? [], to: op.tags });
          if (op.tags.length) p.tags = [...op.tags]; else delete p.tags;
          dirty.add(`prefab:${op.name}`);
        }
      }
      if (op.base !== undefined && (op.base ?? undefined) !== p.base) {
        // 派生の元を変える・切り離す。どちらも、今の中身（元と重ねた値）は変えない
        const now = resolvePrefab(docs.prefabs, op.name);
        let next: PrefabDoc;
        if (op.base === null) {
          next = order({ name: op.name, desc: now.desc, tags: now.tags, components: structuredClone(now.components) });
          track.drop(op.name);
        } else {
          need(op.base);
          if (baseChain(docs.prefabs, op.base).some((x) => x.name === op.name)) throw new Error(`@${op.base} は @${op.name} から派生しているので、元にできません（輪になる）`);
          const b = resolvePrefab(docs.prefabs, op.base);
          const comps: Record<string, Record<string, unknown>> = {};
          for (const [c, v] of Object.entries(now.components)) {
            const bc = b.components[c];
            if (!bc) { comps[c] = structuredClone(v); continue; }
            const own: Record<string, unknown> = {};
            for (const k of Object.keys(v)) if (!same(v[k], bc[k])) own[k] = structuredClone(v[k]);
            if (Object.keys(own).length) comps[c] = own;
          }
          const remove = Object.keys(b.components).filter((c) => !now.components[c]);
          next = order({ name: op.name, base: op.base, desc: now.desc !== b.desc ? now.desc : undefined, tags: same(now.tags, b.tags) ? undefined : now.tags, remove, components: comps });
        }
        docs.prefabs.set(op.name, next);
        if (next.base) { track.drop(op.name); track.add(op.name, true); }
        dirty.add(`prefab:${op.name}`);
        changes.push({ path: `prefab:${op.name}.base`, from: p.base ?? null, to: op.base });
      }
      return;
    }
    case 'revert': {
      const a = parseAddress(op.path);
      if (a.kind === 'table') throw new Error('revert は、シーン・プレハブの値に使います（表の値は set で）');
      if (!a.component) throw new Error(`revert には部品か値までの住所が要ります（例 @enemy_fast.Health.hp）。受け取った値: ${op.path}`);
      if (a.sub.length) throw new Error(`revert はフィールドごとです（リストや構造体の中ではなく ${op.path.replace(/[[.][^.[]*$/, '')} まで）`);
      const { holder, key } = holderOf(docs, a);
      const variant = a.kind === 'prefab' ? (holder as PrefabDoc).base : (holder as EntityData).prefab;
      const base = variant ? resolvePrefab(docs.prefabs, variant) : undefined;
      const bc = base?.components[a.component];
      if (!a.field) {
        if (!bc) throw new Error(`${op.path}: 部品ごとに戻せるのは、派生・インスタンスが元から受け継いだ部品だけです（元はプレハブ）${variant ? `（${a.component} は @${variant} にありません。外すなら removeComponent）` : ''}`);
        const from = holder.components[a.component];
        if (same(from, bc)) return;
        holder.components[a.component] = structuredClone(bc);
        changes.push({ path: op.path, ...(from ? { from } : {}), to: from ? 'replaced' : 'added' });
        dirty.add(key);
        return;
      }
      const comp = holder.components[a.component];
      if (!comp) throw new Error(`${op.path}: 部品 ${a.component} が付いていません${suggest(a.component, Object.keys(holder.components))}`);
      const top = reg.component(a.component).fields[a.field];
      if (!top) throw new Error(`${a.component} に ${a.field} はありません${suggest(a.field, Object.keys(reg.component(a.component).fields))}`);
      const from = a.field in comp ? comp[a.field] : defaultOf(top);
      const inherit = bc && a.field in bc;
      const to = inherit ? bc[a.field] : defaultOf(top);
      if (inherit) comp[a.field] = structuredClone(bc[a.field]);
      else delete comp[a.field];
      if (same(from, to)) return;
      changes.push({ path: op.path, from, to });
      dirty.add(key);
      return;
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
  for (const p of docs.prefabs.values()) for (const [at, comps] of prefabHolders(p)) fix(at, comps, `prefab:${p.name}`);
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
  for (const p of docs.prefabs.values()) for (const [at, comps] of prefabHolders(p)) fix(at, comps, `prefab:${p.name}`);
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
