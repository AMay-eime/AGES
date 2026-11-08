// 操作ログ（.ages/oplog.jsonl）と、人が触った値の索引（.ages/touched.json）。
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Change } from '../core/patch.ts';

export interface Actor {
  /** 名前（人はエディタで設定した名前、AIは "ai" など） */
  who: string;
  /** system はロックの自動復元など、AGES自身による変更 */
  kind: 'human' | 'ai' | 'system';
  /** どのウインドウから（inspector / hierarchy / text / window:xxx / cli） */
  win?: string;
}

export interface LogEntry {
  t: string;
  who: string;
  kind: 'human' | 'ai' | 'system';
  win?: string;
  op: string;
  path: string;
  from?: unknown;
  to?: unknown;
}

export interface TouchMark {
  who: string;
  t: string;
}

const dirOf = (root: string) => join(root, '.ages');

export async function appendLog(root: string, actor: Actor, op: string, changes: Change[]): Promise<LogEntry[]> {
  if (!changes.length) return [];
  await mkdir(dirOf(root), { recursive: true });
  const t = new Date().toISOString();
  const entries: LogEntry[] = changes.map((c) => {
    const e: LogEntry = { t, who: actor.who, kind: actor.kind, op, path: c.path };
    if (actor.win) e.win = actor.win;
    if (c.from !== undefined) e.from = c.from;
    if (c.to !== undefined) e.to = c.to;
    return e;
  });
  await appendFile(join(dirOf(root), 'oplog.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return entries;
}

export async function readLog(root: string): Promise<LogEntry[]> {
  try {
    const text = await readFile(join(dirOf(root), 'oplog.jsonl'), 'utf8');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export async function readTouched(root: string): Promise<Record<string, TouchMark>> {
  try {
    return JSON.parse(await readFile(join(dirOf(root), 'touched.json'), 'utf8'));
  } catch {
    return {};
  }
}

export async function markTouched(root: string, actor: Actor, changes: Change[]): Promise<void> {
  if (actor.kind !== 'human' || !changes.length) return;
  const touched = await readTouched(root);
  const t = new Date().toISOString();
  for (const c of changes) {
    if (c.to === 'removed') {
      for (const k of Object.keys(touched)) if (k === c.path || k.startsWith(c.path + '.')) delete touched[k];
    } else {
      touched[c.path] = { who: actor.who, t };
    }
  }
  await mkdir(dirOf(root), { recursive: true });
  await writeFile(join(dirOf(root), 'touched.json'), JSON.stringify(touched, null, 2) + '\n');
}

/** AIが前回どこまで読んだか（行数） */
export async function readCursor(root: string): Promise<number> {
  try {
    return Number(await readFile(join(dirOf(root), 'ai-cursor'), 'utf8')) || 0;
  } catch {
    return 0;
  }
}

export async function writeCursor(root: string, n: number): Promise<void> {
  await mkdir(dirOf(root), { recursive: true });
  await writeFile(join(dirOf(root), 'ai-cursor'), String(n));
}

/** この端末の時刻で「11/08 19:25」の形にする */
export function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const short = (v: unknown) => {
  if (v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 40 ? s.slice(0, 37) + '...' : s;
};

/**
 * 要約。同じ値への連続した変更は「最初→最後 ×回数」にまとめる。
 * 例: yamamoto(human) 3件: main#player.Mover.speed 4→5 ×3
 */
export function summarize(entries: LogEntry[]): string {
  if (!entries.length) return '変更なし';
  const byWho = new Map<string, LogEntry[]>();
  for (const e of entries) {
    const k = `${e.who}(${e.kind === 'human' ? '人' : e.kind === 'ai' ? 'AI' : 'AGES'})`;
    byWho.set(k, [...(byWho.get(k) ?? []), e]);
  }
  const lines: string[] = [];
  for (const [who, list] of byWho) {
    // 値の変更とロック操作は別々にまとめる
    const byPath = new Map<string, LogEntry[]>();
    for (const e of list) {
      const k = `${e.path}\u0000${e.op === 'lock' || e.op === 'unlock' ? 'lock' : 'value'}`;
      byPath.set(k, [...(byPath.get(k) ?? []), e]);
    }
    const first = localTime(list[0].t);
    const last = localTime(list[list.length - 1].t);
    lines.push(`${who} ${list.length}件 ${first}〜${last}`);
    for (const [key, es] of byPath) {
      const path = key.split('\u0000')[0];
      const a = es[0];
      const b = es[es.length - 1];
      const n = es.length > 1 ? ` ×${es.length}` : '';
      if (b.op === 'lock' || b.op === 'unlock') lines.push(`  ${path} ${b.op === 'lock' ? '🔒ロック' : 'ロック解除'}`);
      else if (b.to === 'added' || b.to === 'removed') lines.push(`  ${path} ${b.to === 'added' ? '追加' : '削除'}${n}`);
      else if (a.op === 'file') lines.push(`  ${path} ファイル編集${n}`);
      else lines.push(`  ${path} ${short(a.from)}→${short(b.to)}${n}`);
    }
  }
  return lines.join('\n');
}

// ---- ロック ----
// ロックされた値は、AIからはどんな方法（--force を含む）でも変えられない。
// ロックの設定・解除は人だけ（エディタから）。値も一緒に保存し、ファイルが直接書き換えられても復元する。

export interface LockMark {
  who: string;
  t: string;
  /** ロックした時点の値（人が編集すると更新される） */
  value: unknown;
  note?: string;
}

export async function readLocks(root: string): Promise<Record<string, LockMark>> {
  try {
    return JSON.parse(await readFile(join(dirOf(root), 'locks.json'), 'utf8'));
  } catch {
    return {};
  }
}

export async function writeLocks(root: string, actor: Actor, locks: Record<string, LockMark>): Promise<void> {
  if (actor.kind !== 'human') throw new Error('ロックの設定・解除は人だけができます（エディタから操作してください）');
  await mkdir(dirOf(root), { recursive: true });
  await writeFile(join(dirOf(root), 'locks.json'), JSON.stringify(locks, null, 2) + '\n');
}

/** パスがロック対象か（ロックされたパスそのもの、またはその親を消す操作） */
export function lockedHits(locks: Record<string, LockMark>, target: string): string[] {
  return Object.keys(locks).filter((p) => p === target || p.startsWith(target + '.'));
}
