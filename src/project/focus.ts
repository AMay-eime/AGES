// エディタで人が見ている所（開いているシーン・選んでいる物・表の行・開いている拡張の窓）。
// 人の依頼は画面を指して出てくることが多い（「この敵」「これを大きく」）ので、AI が探さずに済むよう、地図の先頭に1行出し、ages find の並びに使う。
// 手元のパソコンだけのもの（AGES_HOME に置く。Git には上げない）。エディタを閉じる・しばらく触らないと出さない
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { agesHome } from './seal.ts';
import type { Project } from './project.ts';
import type { RecentStore } from './recent.ts';

export interface EditorFocus {
  /** 書いた時刻（エディタは開いている間、1分ごとに書き直す） */
  at: string;
  /** 開いているシーン */
  scene?: string;
  /** 選んでいる物（シーン#ID か @プレハブ。手前の物が最初） */
  selected?: string[];
  /** 表のエディタで選んでいる行（$表.行） */
  row?: string;
  /** 表のエディタで開いている表（見えているときだけ） */
  table?: string;
  /** 見えているエディタ拡張の窓（id と見出し） */
  windows?: { id: string; title?: string }[];
}

/** これより古い（エディタを閉じた・触っていない）ものは使わない */
export const FOCUS_MAX_AGE_MS = 3 * 60_000;

const fileOf = (root: string) => join(agesHome(), 'focus', createHash('sha1').update(resolve(root)).digest('hex') + '.json');

/** エディタから。null なら消す（エディタを閉じた） */
export async function writeFocus(root: string, f: Omit<EditorFocus, 'at'> | null, now = new Date()): Promise<void> {
  const file = fileOf(root);
  if (!f) { await rm(file, { force: true }); return; }
  const clean: EditorFocus = { at: now.toISOString() };
  if (typeof f.scene === 'string' && f.scene) clean.scene = f.scene;
  if (Array.isArray(f.selected)) clean.selected = f.selected.filter((x) => typeof x === 'string').slice(0, 20);
  if (typeof f.row === 'string' && f.row) clean.row = f.row;
  if (typeof f.table === 'string' && f.table) clean.table = f.table;
  if (Array.isArray(f.windows)) clean.windows = f.windows.filter((w) => w && typeof w.id === 'string').slice(0, 8).map((w) => ({ id: w.id, ...(typeof w.title === 'string' ? { title: w.title } : {}) }));
  await mkdir(join(agesHome(), 'focus'), { recursive: true });
  await writeFile(file, JSON.stringify(clean) + '\n');
}

/** 新しいものだけ（なければ・古ければ null） */
export async function readFocus(root: string, now = Date.now()): Promise<EditorFocus | null> {
  try {
    const f = JSON.parse(await readFile(fileOf(root), 'utf8')) as EditorFocus;
    const t = Date.parse(f.at);
    return Number.isFinite(t) && now - t <= FOCUS_MAX_AGE_MS ? f : null;
  } catch {
    return null;
  }
}

/** 地図の先頭の1行（見ている物の部品も添える） */
export function focusLine(p: Project, f: EditorFocus): string | null {
  const parts: string[] = [];
  if (f.scene) parts.push(`シーン ${f.scene}`);
  const sel = f.selected ?? [];
  if (sel.length) {
    const first = sel[0];
    const comps = componentsOf(p, first);
    parts.push(`選んでいる物 ${first}${comps ? ` [${comps}]` : ''}${sel.length > 1 ? `（ほかに ${sel.slice(1, 6).join(' ')}${sel.length > 6 ? ' …' : ''}）` : ''}`);
  }
  if (f.row) parts.push(`表の行 ${f.row}`);
  else if (f.table) parts.push(`表 $${f.table}`);
  if (f.windows?.length) parts.push(`開いている窓 ${f.windows.map((w) => `${w.id}${w.title ? `「${w.title}」` : ''}`).join(' ')}`);
  if (!parts.length) return null;
  const at = new Date(f.at);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `エディタで人が見ている所（${hhmm}）: ${parts.join('・')}（人が「これ」「この〜」「選んでいる〜」と言ったら、まずここ）`;
}

function componentsOf(p: Project, addr: string): string {
  try {
    if (addr.startsWith('@')) {
      const pf = p.registry.findPrefab(addr.slice(1));
      return pf ? Object.keys(pf.components).join(' ') : '';
    }
    const [scene, id] = addr.split('#');
    const raw = p.docs.scenes.get(scene);
    if (!raw) return '';
    const e = p.resolvedScene(raw).entities.find((x) => x.id === id);
    return e ? `${Object.keys(e.components).join(' ')}${e.prefab ? ` ←@${e.prefab}` : ''}` : '';
  } catch {
    return '';
  }
}

/** ages find の並びに使う: 見ている所を、最近の作業の場所よりも強い重みで足す */
export function withFocus(store: RecentStore, f: EditorFocus | null): RecentStore {
  if (!f) return store;
  const places = [...(f.selected ?? []), ...(f.row ? [f.row.split('.')[0]] : []), ...(f.table ? [`$${f.table}`] : [])];
  if (!places.length) return store;
  const top = Math.max(1, ...Object.values(store.places).map((e) => e.hits));
  const out: RecentStore = { n: store.n, places: { ...store.places } };
  for (const place of places) out.places[place] = { hits: top + 2, last: store.n };
  return out;
}
