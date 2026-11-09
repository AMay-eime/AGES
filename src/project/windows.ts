// プロジェクト独自のエディタ拡張（editor/*.window.ts・*.ext.ts）の宣言を、Node 側で読む。
// 中身（mount）は動かさず、id・名前・説明・変える値・使う窓口だけを使う（地図・検証・変える値の制限）。
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAddress } from '../core/docs.ts';
import { suggest, type Field } from '../core/schema.ts';
import { matchRank, matchWithin, splitMatch, subProblem } from '../core/drawers.ts';

export interface WindowInfo {
  path: string;
  id?: string;
  title?: string;
  desc?: string;
  edits?: string[];
  /** パネルがある */
  panel?: boolean;
  /** インスペクタの欄の見せ方の match（型・部品.フィールド・住所） */
  fields?: string[];
  /** インスペクタの部品の見せ方の部品 */
  components?: string[];
  /** 表のエディタの行の見せ方の表 */
  rows?: string[];
  /** 右クリックのメニューの項目の名前 */
  menus?: string[];
  /** 読み込めなかった理由 */
  error?: string;
}

/** 住所の決まり（'.*' で中をまとめて）。中を指すかどうかの判定に使う */
export const editRoot = (pattern: string) => pattern.replace(/\.\*$/, '').replace(/\|\*$/, '');

/** target が edits のどれかの中（か同じ）か */
export function withinEdits(edits: string[], target: string): boolean {
  return edits.some((e) => {
    const root = editRoot(e);
    return target === root || target.startsWith(root + '.') || target.startsWith(root + '[') || target.startsWith(root + '|');
  });
}

export async function loadWindows(dir: string, paths: string[]): Promise<WindowInfo[]> {
  const out: WindowInfo[] = [];
  for (const path of paths) {
    try {
      const mod = await import(pathToFileURL(join(dir, path)).href);
      const w = mod.default as Record<string, any> | undefined;
      if (!w || typeof w !== 'object') { out.push({ path, error: 'export default defineExtension({...})（か defineWindow）がありません' }); continue; }
      const panel = typeof w.mount === 'function' || typeof w.panel?.mount === 'function';
      out.push({
        path, id: w.id, title: w.title ?? w.panel?.title, desc: w.desc, edits: Array.isArray(w.edits) ? w.edits.map(String) : undefined, panel,
        ...(Array.isArray(w.fields) ? { fields: w.fields.flatMap((d: { match?: unknown }) => [d?.match ?? []].flat().map(String)) } : {}),
        ...(Array.isArray(w.components) ? { components: w.components.map((d: { component?: unknown }) => String(d?.component)) } : {}),
        ...(Array.isArray(w.rows) ? { rows: w.rows.map((d: { table?: unknown }) => String(d?.table)) } : {}),
        ...(Array.isArray(w.menus) ? { menus: w.menus.map((d: { label?: unknown }) => String(d?.label)) } : {}),
      });
    } catch (e) {
      out.push({ path, error: `読み込めません（モジュールの一番外で document などのブラウザの物を使わない）: ${(e as Error).message.split('\n')[0]}` });
    }
  }
  return out;
}

/** editor/ にあるのに ages.project.json の editorWindows に書いていないウインドウ */
export async function unlistedWindows(dir: string, paths: string[]): Promise<string[]> {
  let names: string[] = [];
  try { names = await readdir(join(dir, 'editor')); } catch { return []; }
  return names.filter((n) => n.endsWith('.window.ts') || n.endsWith('.ext.ts')).map((n) => `editor/${n}`).filter((p) => !paths.includes(p));
}

/**
 * 欄・部品・行の見せ方を持つ拡張が、見せている値として変えてよいか（edits に書かなくても変えられる）。
 * 欄は当たる欄とその中（入れ子の中・表の欄も）、部品はその部品、行はその表の行の値（列。行を足す・消すのは edits で）。
 * typesAt(target) は、その値のフィールド（列）の一番外から target までの型（型で選ぶ見せ方のため）
 */
export function allowedByDrawers(w: WindowInfo, target: string, typesAt: (target: string) => string[]): boolean {
  let a: ReturnType<typeof parseAddress>;
  try { a = parseAddress(target); } catch { return false; }
  if (a.kind === 'table') {
    if (!a.entity || !a.field) return false;
    if (w.rows?.includes(a.doc)) return true;
  } else {
    if (!a.component) return false;
    if (w.components?.includes(a.component)) return true;
    if (!a.field) return false;
  }
  const fields = w.fields ?? [];
  if (!fields.length) return false;
  const types = fields.some((m) => matchRank(m) === 1) ? typesAt(target) : [];
  return fields.some((m) => matchWithin(m, target, types));
}

/**
 * ウインドウの宣言の問題（地図とずれないように）。
 * fieldOf は欄の見せ方の match の頭（住所・部品.フィールド・$表.列）の型か、ない理由
 */
export function checkWindows(list: WindowInfo[], exists: (address: string) => string | null, part: (component: string, field?: string) => string | null = () => null, types: string[] = [], fieldOf: (head: string) => Field | string = () => '型を調べられません'): string[] {
  const errs: string[] = [];
  const ids = new Map<string, string>();
  for (const w of list) {
    if (w.error) { errs.push(`${w.path}: ${w.error}`); continue; }
    if (!w.id || !/^[A-Za-z0-9_-]+$/.test(w.id)) errs.push(`${w.path}: id には英数字・_・- だけを使います（受け取った値: ${JSON.stringify(w.id)}）`);
    else if (ids.has(w.id)) errs.push(`${w.path}: id ${w.id} は ${ids.get(w.id)} と同じです`);
    else ids.set(w.id, w.path);
    if (!w.panel && !w.fields?.length && !w.components?.length && !w.rows?.length && !w.menus?.length) errs.push(`${w.path}: 窓口がありません（panel・fields・components・rows・menus のどれか）`);
    if (w.panel && !w.title) errs.push(`${w.path}: title がありません（パネルのタブの名前）`);
    if (!w.desc) errs.push(`${w.path}: desc（何のための拡張か、1行）がありません。地図に出ます`);
    if (w.panel && !w.edits) errs.push(`${w.path}: edits（パネルが変える値の住所）がありません。地図に出て、それ以外は変えられなくなります（何も変えないなら edits: []）`);
    for (const m of w.fields ?? []) {
      let bad: string | null;
      if (matchRank(m) === 1) bad = types.includes(m) ? null : `型 ${m} はありません${suggest(m, types)}（型・部品.フィールド・$表.列・住所のどれか）`;
      else {
        const { head, sub } = splitMatch(m);
        const f = fieldOf(head);
        bad = typeof f === 'string' ? f : sub ? subProblem(f, sub, head, matchRank(m) === 3) : null;
      }
      if (bad) errs.push(`${w.path}: fields の match ${m}: ${bad}`);
    }
    for (const c of w.components ?? []) { const bad = part(c); if (bad) errs.push(`${w.path}: components の ${c}: ${bad}`); }
    for (const t of w.rows ?? []) { const bad = exists(`$${t}`); if (bad) errs.push(`${w.path}: rows の ${t}: ${bad}`); }
    for (const e of w.edits ?? []) {
      try { parseAddress(editRoot(e).replace(/\|.*$/, '')); } catch (err) { if (!e.startsWith('sheet:')) { errs.push(`${w.path}: edits の ${e}: ${(err as Error).message}`); continue; } }
      const bad = exists(editRoot(e));
      if (bad) errs.push(`${w.path}: edits の ${e}: ${bad}`);
    }
  }
  return errs;
}
