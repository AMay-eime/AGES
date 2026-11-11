// 操作ログ（.ages/oplog.jsonl）と、人が触った値の索引（.ages/touched.json）。
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Change } from '../core/patch.ts';
import { sealLocks } from './seal.ts';

export interface Actor {
  /** 名前（人はエディタで設定した名前、AIは "ai" など） */
  who: string;
  /** system はロックの自動復元など、AGES自身による変更 */
  kind: 'human' | 'ai' | 'system';
  /** どのウインドウから（inspector / hierarchy / text / window:xxx / cli） */
  win?: string;
  /** AI の作業（ages talk --task）の ID。エディタで AI の変更を作業ごとにまとめる */
  task?: string;
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
  /** 別の変更に合わせて自動で直したもの */
  auto?: boolean;
  /** 派生が受け継いでいる値で、この元の変更に合わせて変わったもの */
  via?: string;
  /** 1回の編集（元に戻す単位）の ID */
  tx?: string;
  /** AI の作業の ID（ages talk --task） */
  task?: string;
}

export interface TouchMark {
  who: string;
  t: string;
}

const dirOf = (root: string) => join(root, '.ages');

export async function appendLog(root: string, actor: Actor, op: string, changes: Change[], tx?: string): Promise<LogEntry[]> {
  if (!changes.length) return [];
  await mkdir(dirOf(root), { recursive: true });
  const t = new Date().toISOString();
  const entries: LogEntry[] = changes.map((c) => {
    const e: LogEntry = { t, who: actor.who, kind: actor.kind, op, path: c.path };
    if (actor.win) e.win = actor.win;
    if (c.from !== undefined) e.from = c.from;
    if (c.to !== undefined) e.to = c.to;
    if (c.auto) e.auto = true;
    if (c.via) e.via = c.via;
    if (tx) e.tx = tx;
    if (actor.task) e.task = actor.task;
    return e;
  });
  await appendFile(join(dirOf(root), 'oplog.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return entries;
}

export async function readLog(root: string): Promise<LogEntry[]> {
  return (await readLogLines(root)).map((l) => JSON.parse(l));
}

/** 操作ログの行（そのままの文字。どの行が増えたかを見分けるため） */
export async function readLogLines(root: string): Promise<string[]> {
  try {
    return (await readFile(join(dirOf(root), 'oplog.jsonl'), 'utf8')).split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
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
  for (const raw of changes) {
    if (raw.auto) continue; // 自動で直した参照は、人が調整した値ではない
    if (/^(file|scene|prefab):|^config\./.test(raw.path)) continue; // ファイル・シーン・プレハブの出し入れと設定は、値の調整ではない
    // 行列のセルの変更（...formation[2,3]）は行列全体への印に、切り方の変更（sheet:x.png|コマ.rect）はシート全体への印にする
    const sheetPart = raw.path.startsWith('sheet:') && raw.path.includes('|');
    // リストの中の変更はリスト全体への印にする（要素の番号は並べ替えで変わるため）
    const inList = !sheetPart && /\[\d+\]/.test(raw.path);
    const base = sheetPart ? raw.path.split('|')[0] : raw.path.replace(/\[\d+,\s*\d+\]$/, '').replace(/\[\d+\].*$/, '');
    // コマを1つ消しても、シートの印は消さない
    const c = { ...raw, path: base, to: sheetPart || inList ? 'changed' : raw.to };
    if (typeof raw.to === 'string' && raw.to.startsWith('renamed:')) {
      // 行の ID を変えた: 印も付け替え、行に印を付ける
      const to = raw.path.replace(/[^.]+$/, raw.to.slice('renamed:'.length));
      for (const k of Object.keys(touched)) if (k === raw.path || k.startsWith(raw.path + '.')) { touched[to + k.slice(raw.path.length)] = touched[k]; delete touched[k]; }
      touched[to] = { who: actor.who, t };
    } else if (c.to === 'removed') {
      for (const k of Object.keys(touched)) if (k === c.path || k.startsWith(c.path + '.')) delete touched[k];
    } else {
      touched[c.path] = { who: actor.who, t };
    }
  }
  await mkdir(dirOf(root), { recursive: true });
  await writeFile(join(dirOf(root), 'touched.json'), JSON.stringify(touched, null, 2) + '\n');
}

/** ファイルを動かした・消したとき、その画像の切り方の印（sheet:<画像>）も付け替える */
export async function moveTouched(root: string, files: { from: string; to: string | null; dir: boolean }[]): Promise<void> {
  const touched = await readTouched(root);
  let changed = false;
  for (const f of files) {
    for (const k of Object.keys(touched)) {
      const img = k.startsWith('sheet:') ? k.slice('sheet:'.length).split('|')[0] : null;
      if (!img || !(img === f.from || (f.dir && img.startsWith(f.from + '/')))) continue;
      if (f.to !== null) touched['sheet:' + f.to + k.slice('sheet:'.length + f.from.length)] = touched[k];
      delete touched[k];
      changed = true;
    }
  }
  if (!changed) return;
  await mkdir(dirOf(root), { recursive: true });
  await writeFile(join(dirOf(root), 'touched.json'), JSON.stringify(touched, null, 2) + '\n');
}

/** 住所の頭が変わったとき（シーンの名前の変更など）、★も付け替える。to が null なら消す */
export async function movePrefixTouched(root: string, from: string, to: string | null): Promise<void> {
  const touched = await readTouched(root);
  let changed = false;
  for (const k of Object.keys(touched)) {
    if (!k.startsWith(from)) continue;
    if (to !== null) touched[to + k.slice(from.length)] = touched[k];
    delete touched[k];
    changed = true;
  }
  if (!changed) return;
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
      // 行列のセルの変更は行列ごとに、画像の切り方の変更は画像ごとにまとめる
      const cell = /\[\d+,\s*\d+\]$/.test(e.path);
      const sheet = e.path.startsWith('sheet:') && e.path.includes('|');
      // リストの中の変更・リストの並べ替えは、リストごとにまとめる（番号は動くので、1件ずつ並べると分かりにくい）
      const list = !cell && !sheet && (/\[\d+\]/.test(e.path) || e.op === 'insert' || e.op === 'removeItem' || e.op === 'moveItem');
      const k = cell ? `${e.path.replace(/\[\d+,\s*\d+\]$/, '')}\u0000cells`
        : sheet ? `${e.path.split('|')[0]}\u0000sheet`
        : list ? `${e.path.replace(/\[\d+\].*$/, '')}\u0000list`
        : `${e.path}\u0000${e.op === 'lock' || e.op === 'unlock' ? 'lock' : 'value'}`;
      byPath.set(k, [...(byPath.get(k) ?? []), e]);
    }
    const first = localTime(list[0].t);
    const last = localTime(list[list.length - 1].t);
    lines.push(`${who} ${list.length}件 ${first}〜${last}`);
    for (const [key, es] of byPath) {
      const [path, kind] = key.split('\u0000');
      if (kind === 'cells') {
        const cells = new Set(es.map((e) => e.path.slice(path.length)));
        const sample = es.slice(0, 3).map((e) => `${e.path.slice(path.length)} ${short(e.from)}→${short(e.to)}`).join(', ');
        lines.push(`  ${path} 行列 ${cells.size}セル変更（${sample}${es.length > 3 ? ' …' : ''}）。全体は ages get で確認`);
        continue;
      }
      if (kind === 'sheet') {
        const parts = es.map((e) => e.path.split('|')[1]);
        const added = es.filter((e) => e.to === 'added').length, removed = es.filter((e) => e.to === 'removed').length;
        const sample = [...new Set(parts)].slice(0, 4).join(', ');
        lines.push(`  ${path} 切り方 ${es.length}件変更（追加${added}・削除${removed}・変更${es.length - added - removed}: ${sample}${parts.length > 4 ? ' …' : ''}）。全体は ages sheet で確認`);
        continue;
      }
      if (kind === 'list') {
        const what = (e: LogEntry) => {
          const at = e.path.slice(path.length) || '';
          if (e.to === 'added') return `${at} 追加`;
          if (e.to === 'removed') return `${at} 削除`;
          if (typeof e.to === 'string' && e.to.startsWith('moved:')) return `${at}→${e.to.slice('moved:'.length)} 移動`;
          return `${at} ${short(e.from)}→${short(e.to)}`;
        };
        lines.push(`  ${path} リスト ${es.length}件変更（${es.slice(0, 3).map(what).join(', ')}${es.length > 3 ? ' …' : ''}）。全体は ages get で確認`);
        continue;
      }
      const a = es[0];
      const b = es[es.length - 1];
      const n = es.length > 1 ? ` ×${es.length}` : '';
      if (b.op === 'lock' || b.op === 'unlock') lines.push(`  ${path} ${b.op === 'lock' ? '🔒ロック' : 'ロック解除'}`);
      else if (b.to === 'added' || b.to === 'removed') lines.push(`  ${path} ${b.to === 'added' ? '追加' : '削除'}${n}`);
      else if (a.op === 'file') lines.push(`  ${path} ファイル編集${n}`);
      else if (path.startsWith('file:') && b.to === 'replaced') lines.push(`  ${path} 差し替え${n}`);
      else if (/^(scene|prefab):/.test(path) && typeof b.to === 'string' && b.to.startsWith('renamed:')) lines.push(`  ${path} 名前を ${b.to.slice('renamed:'.length)} に変更`);
      else if (path.startsWith('file:')) lines.push(`  ${path} 場所を ${b.to} に変更（使っている値も直した）`);
      else if (typeof b.to === 'string' && b.to.startsWith('renamed:')) lines.push(`  ${path} ID を ${b.to.slice('renamed:'.length)} に変更`);
      else lines.push(`  ${path} ${short(a.from)}→${short(b.to)}${n}${b.via ? `（${b.via} の変更で）` : b.auto ? '（自動）' : ''}${b.op === 'undo' ? '（元に戻す）' : b.op === 'redo' ? '（やり直し）' : ''}`);
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
  const text = JSON.stringify(locks, null, 2) + '\n';
  await writeFile(join(dirOf(root), 'locks.json'), text);
  await sealLocks(root, text);
}

/** パスがロック対象か（ロックされたパスそのもの、またはその親を消す操作） */
/** target を変えると影響するロック（同じ値・target の中のロック・target を含むロック） */
export function lockedHits(locks: Record<string, LockMark>, target: string): string[] {
  const inside = (a: string, b: string) => a.startsWith(b + '.') || a.startsWith(b + '[');
  return Object.keys(locks).filter((p) => p === target || inside(p, target) || inside(target, p));
}
