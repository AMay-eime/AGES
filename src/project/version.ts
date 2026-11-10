// AGES の版と互換の番号。プロジェクトを作ったとき（と、新しい本体に合わせて直したとき）に ages.project.json の engine に残す。
// 互換の番号（COMPAT）は、今までのプロジェクトに直しが要る変更をするたびに1つ上げ、docs/MIGRATIONS.md に直し方を書く。
// プロジェクトの記録が今の番号より小さければ、ages check とエディタが知らせ、ages version が要る項だけを出す
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 互換の番号（docs/MIGRATIONS.md の最後の項の番号と同じ。test/version.test.ts が確かめる） */
export const COMPAT = 1;

export interface EngineVersion { compat: number; version: string; commit?: string; recorded?: string }

const ENGINE_DIR = fileURLToPath(new URL('../..', import.meta.url));
export const MIGRATIONS_FILE = join(ENGINE_DIR, 'docs', 'MIGRATIONS.md');
let cached: EngineVersion | undefined;

/** 今動いている AGES 本体の版（互換の番号・package.json の version・git で取っていればコミット） */
export function engineVersion(): EngineVersion {
  if (cached) return cached;
  const version = String(JSON.parse(readFileSync(join(ENGINE_DIR, 'package.json'), 'utf8')).version);
  let commit: string | undefined;
  try {
    commit = execFileSync('git', ['-C', ENGINE_DIR, 'rev-parse', '--short=7', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined;
  } catch { /* ZIP で取った本体など。版だけ */ }
  return (cached = { compat: COMPAT, version, commit });
}

/** 本体の git のコミット（40文字）。git で取っていなければ undefined */
export function engineCommitFull(): string | undefined {
  try {
    return execFileSync('git', ['-C', ENGINE_DIR, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined;
  } catch { return undefined; }
}

export const formatVersion = (v: Partial<EngineVersion>): string => `互換${v.compat ?? '?'}・${v.version ?? '?'}${v.commit ? `（${v.commit}）` : ''}`;

/** docs/MIGRATIONS.md の項（番号・見出し・中身） */
export function migrations(text = readFileSync(MIGRATIONS_FILE, 'utf8')): { n: number; title: string; body: string }[] {
  const out: { n: number; title: string; body: string }[] = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const m = /^(\d+)\.\s*(.*)\n([\s\S]*)$/.exec(part);
    if (m) out.push({ n: Number(m[1]), title: m[2].trim(), body: m[3].trim() });
  }
  return out;
}

/**
 * 記録と今の本体の互換の違い（ages check とエディタに出す）。同じなら null。
 * 比べるのは互換の番号だけ（version とコミットは、どの本体だったかの参考）
 */
export function versionNote(rec: Partial<EngineVersion> | undefined, cur: EngineVersion = engineVersion()): string | null {
  if (typeof rec?.compat !== 'number') return `AGES の互換の番号がこのプロジェクトに記録されていません（今の本体は ${formatVersion(cur)}。ages version <dir> --record で残す）`;
  if (rec.compat === cur.compat) return null;
  if (rec.compat > cur.compat) return `このプロジェクトは新しい AGES（互換${rec.compat}）に合わせてあります。今の本体は 互換${cur.compat}。本体を上げる（git pull）`;
  const need = migrations().filter((m) => m.n > rec.compat! && m.n <= cur.compat);
  return `AGES が新しくなっています（互換${rec.compat} → ${cur.compat}）。直し方は ages version <dir>: ${need.map((m) => `${m.n}. ${m.title}`).join(' / ')}`;
}

/** 今の本体の版を ages.project.json の engine に書く */
export async function recordVersion(dir: string, today = new Date().toISOString().slice(0, 10)): Promise<EngineVersion> {
  const file = join(dir, 'ages.project.json');
  const cfg = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const v = { ...engineVersion(), recorded: today };
  cfg.engine = v;
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n');
  return v;
}
