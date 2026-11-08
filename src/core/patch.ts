// 差分編集。AIも人（エディタ）も、ファイルの変更はすべてここを通る。
// 返り値は「何がいくつからいくつに変わったか」だけ。
import { parseAddress, type Address, type EntityData, type PrefabDoc, type SceneDoc } from './docs.ts';
import { checkCell, checkValue, suggest, type CellValue } from './schema.ts';
import type { Registry } from './registry.ts';
import { baseNameOf, checkSheet, findFrame, sheetPathOf, toExplicit, type FrameDef, type FrameRef, type SheetDef } from './sheet.ts';
import { frameMapper, remapRef } from './slice.ts';

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
  | { op: 'setClip'; image: string; clip: string; frames?: FrameRef[]; fps?: number; loop?: boolean; remove?: boolean };

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
}

export interface PatchResult {
  changes: Change[];
  /** 変更があった文書（"scene:main" / "prefab:enemy" / "sheet:assets/x.png"） */
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
  if (path.startsWith('sheet:')) {
    const image = path.slice('sheet:'.length).split('|')[0];
    return { value: docs.sheets.get(image) ?? null, isDefault: false };
  }
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
  const work: Docs = { scenes: structuredClone(docs.scenes), prefabs: structuredClone(docs.prefabs), sheets: structuredClone(docs.sheets) };
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
    const i = k.indexOf(':');
    const kind = k.slice(0, i), name = k.slice(i + 1);
    if (kind === 'scene') docs.scenes.set(name, work.scenes.get(name)!);
    else if (kind === 'prefab') docs.prefabs.set(name, work.prefabs.get(name)!);
    else if (work.sheets.has(name)) docs.sheets.set(name, work.sheets.get(name)!);
    else docs.sheets.delete(name);
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
      if (f.type === 'prefab' && op.value !== '' && !docs.prefabs.has(op.value as string)) {
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
      throw new Error(`未知の操作 ${(op as { op: string }).op}。使えるのは set / setCells / addEntity / removeEntity / addComponent / removeComponent / rename / setSheet / setFrame / setClip`);
  }
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
  return out;
}
