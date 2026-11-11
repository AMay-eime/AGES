// AI の変更を人が確かめたかどうか（エディタの「AI の変更」）と、エディタの外で変わったコードの差分。
// 確かめたかは人ごと・端末ごとなので AGES_HOME に置く（Git では共有しない）。
// 確かめる単位: 操作ログの1回の編集（tx:ID。tx がない行は e:時刻|住所）と、コードの変更（code:ID）。all はその時刻までをすべて
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { agesHome } from './seal.ts';
import type { LogEntry } from './oplog.ts';

export interface CodeChange {
  id: string;
  t: string;
  /** プロジェクトの中の場所 */
  path: string;
  plus: number;
  minus: number;
  /** 消えた・新しくできた */
  gone?: boolean;
  added?: boolean;
  /** そのとき AI が作業中なら、その作業と AI（エディタの外の変更なので、誰が変えたかはこれでしか分からない） */
  task?: string;
  who?: string;
}

export interface ReviewStore {
  /** この時刻までの変更はすべて確かめた */
  all?: string;
  /** 確かめたもの（キー → その変更の時刻。all より古いものは捨てる） */
  ack: Record<string, string>;
  /** コードの変更（新しいものから 300 まで） */
  code: CodeChange[];
}

const dirOf = (root: string) => join(agesHome(), 'review', createHash('sha1').update(resolve(root)).digest('hex'));

export async function readReview(root: string): Promise<ReviewStore> {
  try {
    const r = JSON.parse(await readFile(join(dirOf(root), 'review.json'), 'utf8')) as ReviewStore;
    return { ack: r.ack ?? {}, code: r.code ?? [], ...(r.all ? { all: r.all } : {}) };
  } catch {
    return { ack: {}, code: [] };
  }
}

async function writeReview(root: string, r: ReviewStore): Promise<void> {
  await mkdir(dirOf(root), { recursive: true });
  if (r.all) for (const [k, t] of Object.entries(r.ack)) if (t <= r.all) delete r.ack[k];
  r.code = r.code.slice(-300);
  await writeFile(join(dirOf(root), 'review.json'), JSON.stringify(r) + '\n');
}

/** 確かめた印を付ける（keys はキー → 時刻。all なら今まで全部） */
export async function ackReview(root: string, o: { keys?: Record<string, string>; all?: string }): Promise<void> {
  const r = await readReview(root);
  if (o.all && (!r.all || o.all > r.all)) r.all = o.all;
  for (const [k, t] of Object.entries(o.keys ?? {})) r.ack[k] = t;
  await writeReview(root, r);
}

/** 操作ログの行の、確かめる単位のキー */
export const entryKey = (e: Pick<LogEntry, 't' | 'path' | 'tx'>): string => (e.tx ? `tx:${e.tx}` : `e:${e.t}|${e.path}`);

export function isAcked(r: ReviewStore, key: string, t: string): boolean {
  return (!!r.all && t <= r.all) || key in r.ack;
}

/** コードの変更を残す（差分の中身は別のファイル） */
export async function addCodeChange(root: string, c: Omit<CodeChange, 'id' | 't'>, diff: string, now = new Date()): Promise<CodeChange> {
  const r = await readReview(root);
  const change: CodeChange = { id: randomBytes(4).toString('hex'), t: now.toISOString(), ...c };
  r.code.push(change);
  await mkdir(join(dirOf(root), 'diffs'), { recursive: true });
  await writeFile(join(dirOf(root), 'diffs', `${change.id}.diff`), diff);
  await writeReview(root, r);
  return change;
}

export async function readDiff(root: string, id: string): Promise<string | null> {
  if (!/^[0-9a-f]{8}$/.test(id)) return null;
  try { return await readFile(join(dirOf(root), 'diffs', `${id}.diff`), 'utf8'); } catch { return null; }
}

/**
 * 行ごとの差分（前後 2 行の文脈つき。+ は足した行、- は消した行）。同じ先頭と末尾を外してから比べる。
 * 中が大きすぎるとき（行の数の積が 400 万を超える）は、まとめて置き換えたものとして出す
 */
export function lineDiff(before: string, after: string, context = 2, maxLines = 400): { text: string; plus: number; minus: number } {
  const a = before === '' ? [] : before.replace(/\r\n/g, '\n').split('\n');
  const b = after === '' ? [] : after.replace(/\r\n/g, '\n').split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail), bm = b.slice(head, b.length - tail);
  // 1行ごとの印: ' ' 同じ / '-' 消した / '+' 足した
  const ops: [string, string][] = [];
  if (am.length * bm.length > 4_000_000) {
    for (const l of am) ops.push(['-', l]);
    for (const l of bm) ops.push(['+', l]);
  } else {
    const n = am.length, m = bm.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = am[i] === bm[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) { ops.push([' ', am[i]]); i++; j++; }
      else if (j < m && (i >= n || lcs[i][j + 1] > lcs[i + 1][j])) { ops.push(['+', bm[j]]); j++; }
      else { ops.push(['-', am[i]]); i++; }
    }
  }
  const plus = ops.filter((o) => o[0] === '+').length, minus = ops.filter((o) => o[0] === '-').length;
  // 文脈: 外した先頭・末尾から少しだけ
  const pre = a.slice(Math.max(0, head - context), head).map((l): [string, string] => [' ', l]);
  const post = a.slice(a.length - tail, a.length - tail + context).map((l): [string, string] => [' ', l]);
  const all = [...pre, ...ops, ...post];
  // 変わった行から離れた同じ行は省く
  const near = all.map((o, k) => o[0] !== ' ' || all.slice(Math.max(0, k - context), k + context + 1).some((x) => x[0] !== ' '));
  const out: string[] = [];
  let line = head - pre.length + 1, skipped = false;
  for (let k = 0; k < all.length; k++) {
    if (!near[k]) { skipped = true; if (all[k][0] !== '+') line++; continue; }
    if (skipped || !out.length) out.push(`@@ ${line} 行目から`);
    skipped = false;
    out.push(`${all[k][0]}${all[k][1]}`);
    if (all[k][0] !== '+') line++;
  }
  const text = out.length > maxLines ? [...out.slice(0, maxLines), `…（ほか ${out.length - maxLines} 行）`].join('\n') : out.join('\n');
  return { text, plus, minus };
}
