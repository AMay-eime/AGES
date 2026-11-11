// アセット（画像・音・フォントのファイル）の場所と、それを使っている値。ブラウザでもNodeでも動く。
// 場所を変えたら使っている値も直し、使われているものは消さない（黙って壊れた参照を作らない）。
import { ASSET_EXT, visit, type AssetKind, type Field } from './schema.ts';
import type { Registry } from './registry.ts';
import type { SceneDoc, PrefabDoc } from './docs.ts';
import type { TableDoc } from './table.ts';

/** アセットを置けないフォルダ（プロジェクトの決まった置き場所） */
export const RESERVED_DIRS = ['scenes', 'prefabs', 'data', 'game', 'editor', 'recordings', 'dist', 'node_modules', '.ages', '.git'];

export function kindOf(path: string): AssetKind | null {
  const p = path.toLowerCase();
  for (const [k, exts] of Object.entries(ASSET_EXT) as [AssetKind, string[]][]) if (exts.some((e) => p.endsWith(e))) return k;
  return null;
}

/** アセットの一覧から、モデルが使っている外の画像（モデルの場所 → 画像の場所） */
export const modelTexturesOf = (assets: { path: string; model?: { textures?: string[] } }[]): Map<string, string[]> =>
  new Map(assets.flatMap((a) => (a.model?.textures?.length ? [[a.path, a.model.textures] as [string, string[]]] : [])));

/** アセットの一覧から、モデルの動きの長さ（場所 → 名前 → 秒）を作る（登録簿の models に入れる） */
export const modelsOf = (assets: { path: string; model?: { clips: string[]; clipSec?: number[] } }[]): Map<string, Record<string, number>> =>
  new Map(assets.flatMap((a) => (a.model ? [[a.path, Object.fromEntries(a.model.clips.map((c, i) => [c, a.model!.clipSec?.[i] ?? 0]))] as [string, Record<string, number>]] : [])));

export const extOf = (path: string) => { const m = path.match(/\.[^./]+$/); return m ? m[0].toLowerCase() : ''; };
export const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
/** path が folder の中（folder 自身は含まない）にあるか */
export const isUnder = (path: string, folder: string) => !folder || path.startsWith(folder + '/');

/** プロジェクトの中の場所として正しいか。正しくなければ理由を返す */
export function checkAssetPath(path: string): string | null {
  if (!path) return '場所が空です';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some((s) => s === '..' || s === '.' || s === '')) return `プロジェクトの中の場所で書いてください（例: assets/ships/player.png）。受け取った値: ${path}`;
  if (/[\\:*?"<>|]/.test(path)) return `場所に使えない文字があります（\\ : * ? " < > |）: ${path}`;
  const top = path.split('/')[0];
  if (RESERVED_DIRS.includes(top)) return `${top}/ はプロジェクトの決まった置き場所なので、アセットは置けません（例: assets/ の下に）`;
  return null;
}

/** 同じ名前があるときの、空いている名前（ship.png → ship-2.png） */
export function freeName(path: string, taken: (p: string) => boolean): string {
  if (!taken(path)) return path;
  const ext = extOf(path);
  const stem = ext ? path.slice(0, -ext.length) : path;
  for (let i = 2; ; i++) if (!taken(`${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`;
}

export interface AssetDocs {
  scenes: Map<string, SceneDoc>;
  prefabs: Map<string, PrefabDoc>;
  tables: Map<string, TableDoc>;
}

/**
 * アセットの場所 → それを使っている値の住所（入れ子の中も）。
 * 画像の切り方（.sheet.json）は画像と一緒に動くので、ここには入れない
 */
export function assetRefs(docs: AssetDocs, reg: Registry): Map<string, string[]> {
  const out = leafRefs(docs, reg, (f) => f.type === 'asset');
  // モデル（.glb）が外のファイルとして使っている画像も、使っている所に数える（未使用に見えて消されないように）
  for (const [model, textures] of reg.modelTextures) for (const t of textures) out.set(t, [...(out.get(t) ?? []), `${model}（モデルの画像）`]);
  return out;
}

/** 値の葉（pick が true の型）の値 → それを持っている住所 */
export function leafRefs(docs: AssetDocs, reg: Registry, pick: (f: Field) => boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (v: unknown, at: string) => {
    if (typeof v !== 'string' || !v) return;
    out.set(v, [...(out.get(v) ?? []), at]);
  };
  const leaf = (f: Field, v: unknown, at: string) => { if (pick(f)) add(v, at); };
  const holder = (base: string, comps: Record<string, Record<string, unknown>>) => {
    for (const [cname, values] of Object.entries(comps)) {
      const def = reg.components.get(cname);
      if (!def) continue;
      for (const [k, f] of Object.entries(def.fields)) if (k in values) visit(f, values[k], `${base}.${cname}.${k}`, leaf);
    }
  };
  for (const s of docs.scenes.values()) for (const e of s.entities) holder(`${s.name}#${e.id}`, e.components);
  for (const p of docs.prefabs.values()) holder(`@${p.name}`, p.components);
  for (const t of docs.tables.values()) {
    const def = reg.tables.get(t.name);
    if (!def) continue;
    for (const r of t.rows) for (const [k, f] of Object.entries(def.columns)) if (k in r) visit(f, r[k], `$${t.name}.${r.id}.${k}`, leaf);
  }
  return out;
}

/** コードの中の ctx.scene.goto('名前') の行き先（名前 → "game/x.ts:12"） */
export function codeSceneRefs(files: Iterable<[string, string]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [file, text] of files) {
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\bgoto\(\s*(['"`])([A-Za-z0-9_-]+)\1/g)) out.set(m[2], [...(out.get(m[2]) ?? []), `${file}:${i + 1}`]);
    });
  }
  return out;
}

/** コードの中でプレハブを名前で指している所: spawn('名前')・sound.play('名前')・sound.volume('区分')（名前 → "game/x.ts:12"） */
export function codePrefabRefs(files: Iterable<[string, string]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [file, text] of files) {
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/(?:\bspawn|\bsound\.play|\bsound\.volume)\(\s*(['"`])([A-Za-z0-9_-]+)\1/g)) out.set(m[2], [...(out.get(m[2]) ?? []), `${file}:${i + 1}`]);
    });
  }
  return out;
}

/** コードの中で、アセットの場所を文字列で書いている所（"game/x.ts:12"）。files は 場所 → 中身 */
export function codeRefs(files: Iterable<[string, string]>, assets: Iterable<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const list = [...assets];
  for (const [file, text] of files) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('.')) return;
      for (const a of list) {
        if (line.includes(`'${a}'`) || line.includes(`"${a}"`) || line.includes(`\`${a}\``)) out.set(a, [...(out.get(a) ?? []), `${file}:${i + 1}`]);
      }
    });
  }
  return out;
}

/**
 * シーンに入る前に読み込むアセット。そのシーンに置いた物が使うもの。
 * first（最初のシーン）なら、プレハブ・表・コードが使うものも（どのシーンからでも出せるので最初に読む）
 */
export function preloadSet(refs: Map<string, string[]>, scene: string, first: boolean, code: Iterable<string> = []): string[] {
  const out = new Set<string>();
  for (const [asset, at] of refs) {
    if (at.some((a) => a.startsWith(scene + '#') || (first && (a.startsWith('@') || a.startsWith('$'))))) out.add(asset);
  }
  if (first) for (const c of code) out.add(c);
  return [...out];
}
