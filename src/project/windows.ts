// プロジェクト独自のエディタ拡張（editor/*.window.ts・*.ext.ts）の宣言を、Node 側で読む。
// 中身（mount）は動かさず、id・名前・説明・変える値・使う窓口だけを使う（地図・検証・変える値の制限）。
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAddress } from '../core/docs.ts';
import { suggest } from '../core/schema.ts';
import type { Op } from '../core/patch.ts';

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

/** 欄・部品の見せ方を持つ拡張が、その欄・部品の値として変えてよいか（edits に書かなくても変えられる） */
export function allowedByDrawers(w: WindowInfo, target: string, typeAt: (component: string, field: string) => string | undefined): boolean {
  let a: ReturnType<typeof parseAddress>;
  try { a = parseAddress(target); } catch { return false; }
  if (a.kind === 'table' || !a.component) return false;
  if (w.components?.includes(a.component)) return true;
  if (!a.field) return false;
  const type = typeAt(a.component, a.field);
  return (w.fields ?? []).some((m) => (m.includes('#') || m.startsWith('@') ? withinEdits([m], target) : m.includes('.') ? m === `${a.component}.${a.field}` : m === type));
}

/** ウインドウの宣言の問題（地図とずれないように） */
export function checkWindows(list: WindowInfo[], exists: (address: string) => string | null, part: (component: string, field?: string) => string | null = () => null, types: string[] = [], tagged: Map<string, number> = new Map(), warns: string[] = []): string[] {
  const errs: string[] = [];
  const ids = new Map<string, string>();
  for (const w of list) {
    if (w.error) { errs.push(`${w.path}: ${w.error}`); continue; }
    if (!w.id || !/^[A-Za-z0-9_-]+$/.test(w.id)) errs.push(`${w.path}: id には英数字・_・- だけを使います（受け取った値: ${JSON.stringify(w.id)}）`);
    else if (ids.has(w.id)) errs.push(`${w.path}: id ${w.id} は ${ids.get(w.id)} と同じです`);
    else ids.set(w.id, w.path);
    if (!w.panel && !w.fields?.length && !w.components?.length && !w.menus?.length) errs.push(`${w.path}: 窓口がありません（panel・fields・components・menus のどれか）`);
    if (w.panel && !w.title) errs.push(`${w.path}: title がありません（パネルのタブの名前）`);
    if (!w.desc) errs.push(`${w.path}: desc（何のための拡張か、1行）がありません。地図に出ます`);
    if (w.panel && !w.edits) errs.push(`${w.path}: edits（パネルが変える値の住所）がありません。地図に出て、それ以外は変えられなくなります（何も変えないなら edits: []）`);
    for (const m of w.fields ?? []) {
      const bad = m.includes('#') || m.startsWith('@') ? exists(m) : m.includes('.') ? part(m.slice(0, m.indexOf('.')), m.slice(m.indexOf('.') + 1)) : types.includes(m) ? null : `型 ${m} はありません${suggest(m, types)}（型・部品.フィールド・住所のどれか）`;
      if (bad) errs.push(`${w.path}: fields の match ${m}: ${bad}`);
    }
    for (const c of w.components ?? []) { const bad = part(c); if (bad) errs.push(`${w.path}: components の ${c}: ${bad}`); }
    for (const e of w.edits ?? []) {
      const t = tagEdit(e);
      if (t) {
        const bad = tagEditProblem(t, part);
        if (bad) errs.push(`${w.path}: edits の ${e}: ${bad}`);
        else if (!tagged.get(t.tag)) warns.push(`${w.path}: edits の ${e}: タグ ${t.tag} のプレハブがまだありません${suggest(t.tag, [...tagged.keys()])}（作ると、この拡張から変えられる）`);
        continue;
      }
      try { parseAddress(editRoot(e).replace(/\|.*$/, '')); } catch (err) { if (!e.startsWith('sheet:')) { errs.push(`${w.path}: edits の ${e}: ${(err as Error).message}`); continue; } }
      const bad = exists(editRoot(e));
      if (bad) errs.push(`${w.path}: edits の ${e}: ${bad}`);
    }
  }
  return errs;
}

// ---------- edits の @[タグ]: そのタグを持つプレハブすべて（これから作るものも） ----------
// タグは派生が元から受け継いだものも数える（ゲームでもエディタでも、派生は元のタグを持つ物として動くため）。
// 変える前にあったプレハブは、前にそのタグを持つこと。変えた後に残るプレハブは、後もそのタグを持つこと（タグを付け替えて外へ逃げる・よそのプレハブを入れる、をさせない）

/** '@[stage]'・'@[enemy].Enemy.*' → { tag, rest }。@[…] でなければ null */
export function tagEdit(pattern: string): { tag: string; rest: string } | null {
  const m = pattern.match(/^@\[([^\]]*)\](.*)$/);
  return m ? { tag: m[1], rest: m[2] } : null;
}

/** @[タグ] の書き方の誤り（タグがない・後ろが .部品.フィールド でない・ない部品やフィールド） */
function tagEditProblem(t: { tag: string; rest: string }, part: (component: string, field?: string) => string | null): string | null {
  if (!t.tag.trim()) return '@[タグ] のタグがありません（例 @[enemy]・@[enemy].Enemy.*）';
  const rest = editRoot(t.rest);
  if (!rest) return null;
  if (!rest.startsWith('.')) return '@[タグ] の後ろは .部品.フィールド です（例 @[enemy].Enemy.*）';
  let a: ReturnType<typeof parseAddress>;
  try { a = parseAddress(`@x${rest}`); } catch (err) { return (err as Error).message; }
  return a.component ? part(a.component, a.field) : null;
}

/** プレハブごとのタグ（派生は、自分で書いていなければ元から受け継いだタグ。resolvePrefab と同じ決まり） */
export function prefabTags(prefabs: Map<string, { name: string; base?: string; tags?: string[] }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const name of prefabs.keys()) {
    const seen = new Set<string>();
    let cur = prefabs.get(name);
    while (cur && !cur.tags && cur.base && !seen.has(cur.name)) { seen.add(cur.name); cur = prefabs.get(cur.base); }
    out.set(name, cur?.tags ? [...cur.tags] : []);
  }
  return out;
}

/** タグごとのプレハブの数（受け継いだタグも。地図と ages check に使う） */
export function tagCounts(prefabs: Map<string, { name: string; base?: string; tags?: string[] }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const tags of prefabTags(prefabs).values()) for (const t of tags) out.set(t, (out.get(t) ?? 0) + 1);
  return out;
}

/** 拡張の変更の住所（op ごと）。名前を変える op は前と後の両方、部品を付ける op は部品まで */
export function windowTargets(op: Op, targetOf: (op: Op) => string | null): string[] {
  switch (op.op) {
    case 'addPrefab': case 'setPrefab': return [`@${op.name}`];
    case 'renamePrefab': return [`@${op.name}`, `@${op.to}`];
    case 'renameRow': return [`$${op.table}.${op.id}`, `$${op.table}.${op.to}`];
    case 'addComponent': return [`${op.target}.${op.component}`];
    case 'addEntity': return [`${op.scene}#${op.entity.id}`];
    case 'rename': return [op.target];
    case 'addRow': return [`$${op.table}.${op.row.id}`];
    case 'moveRow': return [`$${op.table}.${op.id}`];
    default: return [targetOf(op) ?? op.op];
  }
}

/**
 * 住所が edits の中か（@[タグ] も見る）。before は変える前のプレハブのタグ（ない名前は、この変更で作るもの）。
 * @[タグ] で通った住所は keep に入れる（変えた後もそのプレハブが残るなら、そのタグのどれかを持つこと。checkKept で確かめる）
 */
export function windowAllows(edits: string[], target: string, before: Map<string, string[]>, keep: { name: string; tags: string[] }[]): boolean {
  if (withinEdits(edits.filter((e) => !tagEdit(e)), target)) return true;
  const m = target.match(/^@([A-Za-z0-9_-]+)(.*)$/);
  if (!m) return false;
  const [, name, rest] = m;
  const tags = edits.flatMap((e) => {
    const t = tagEdit(e);
    if (!t || !withinEdits([`@${name}${t.rest}`], `@${name}${rest}`)) return [];
    const had = before.get(name);
    return !had || had.includes(t.tag) ? [t.tag] : [];
  });
  if (!tags.length) return false;
  keep.push({ name, tags });
  return true;
}

/** 変えた後に残るプレハブが、通ったときのタグを持ち続けているか。外へ出たものを返す */
export function checkKept(keep: { name: string; tags: string[] }[], after: Map<string, string[]>): string[] {
  const out = new Set<string>();
  for (const k of keep) {
    const now = after.get(k.name);
    if (now && !k.tags.some((t) => now.includes(t))) out.add(`@${k.name}（タグ ${k.tags.join('・')} がなくなる）`);
  }
  return [...out];
}
