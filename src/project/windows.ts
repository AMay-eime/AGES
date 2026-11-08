// プロジェクト独自のエディタウインドウ（editor/*.window.ts）の宣言を、Node 側で読む。
// 中身（mount）は動かさず、id・名前・説明・変える値だけを使う（地図・検証・変える値の制限）。
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAddress } from '../core/docs.ts';

export interface WindowInfo {
  path: string;
  id?: string;
  title?: string;
  desc?: string;
  edits?: string[];
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
      const w = mod.default as Partial<WindowInfo> | undefined;
      if (!w || typeof w !== 'object') { out.push({ path, error: 'export default defineWindow({...}) がありません' }); continue; }
      out.push({ path, id: w.id, title: w.title, desc: w.desc, edits: Array.isArray(w.edits) ? w.edits.map(String) : undefined });
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
  return names.filter((n) => n.endsWith('.window.ts')).map((n) => `editor/${n}`).filter((p) => !paths.includes(p));
}

/** ウインドウの宣言の問題（地図とずれないように） */
export function checkWindows(list: WindowInfo[], exists: (address: string) => string | null): string[] {
  const errs: string[] = [];
  const ids = new Map<string, string>();
  for (const w of list) {
    if (w.error) { errs.push(`${w.path}: ${w.error}`); continue; }
    if (!w.id || !/^[A-Za-z0-9_-]+$/.test(w.id)) errs.push(`${w.path}: id には英数字・_・- だけを使います（受け取った値: ${JSON.stringify(w.id)}）`);
    else if (ids.has(w.id)) errs.push(`${w.path}: id ${w.id} は ${ids.get(w.id)} と同じです`);
    else ids.set(w.id, w.path);
    if (!w.title) errs.push(`${w.path}: title がありません`);
    if (!w.desc) errs.push(`${w.path}: desc（何のためのウインドウか、1行）がありません。地図に出ます`);
    if (!w.edits) errs.push(`${w.path}: edits（変える値の住所）がありません。地図に出て、それ以外は変えられなくなります（何も変えないなら edits: []）`);
    for (const e of w.edits ?? []) {
      try { parseAddress(editRoot(e).replace(/\|.*$/, '')); } catch (err) { if (!e.startsWith('sheet:')) { errs.push(`${w.path}: edits の ${e}: ${(err as Error).message}`); continue; } }
      const bad = exists(editRoot(e));
      if (bad) errs.push(`${w.path}: edits の ${e}: ${bad}`);
    }
  }
  return errs;
}
