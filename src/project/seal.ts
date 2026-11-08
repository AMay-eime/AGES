// ロックの記録（.ages/locks.json）の封印。
// 人がエディタでロックを設定・解除するたびに、プロジェクトの外（使用者のフォルダ）にある秘密の鍵で「封印」を作る。
// 封印と合わない書き換え（AIによる直接編集など）は気づかれずには通らない。最後に封印した内容の控えも、プロジェクトの外に残す。
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface LockIntegrity {
  ok: boolean;
  /** ok=false のときの理由 */
  reason?: string;
  /** 最後に人が封印したときのロックの記録（なければ undefined） */
  backup?: Record<string, { who: string; t: string; value: unknown; note?: string }>;
}

/** 秘密の鍵と控えの置き場所。テストなどでは AGES_HOME で変えられる */
export function agesHome(): string {
  return process.env.AGES_HOME ?? join(homedir(), '.ages');
}

async function secret(create: boolean): Promise<string | null> {
  const file = join(agesHome(), 'secret');
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    if (!create) return null;
    const s = randomBytes(32).toString('hex');
    await mkdir(agesHome(), { recursive: true });
    await writeFile(file, s + '\n', { mode: 0o600 });
    return s;
  }
}

const hmac = (key: string, text: string) => createHmac('sha256', key).update(text).digest('hex');
const backupFile = (root: string) => join(agesHome(), 'sealed', createHash('sha1').update(resolve(root)).digest('hex') + '.json');

/** 人がロックの記録を書いた直後に呼ぶ（呼ぶのは writeLocks だけ） */
export async function sealLocks(root: string, text: string): Promise<void> {
  const key = (await secret(true))!;
  const seal = hmac(key, text);
  await writeFile(join(root, '.ages', 'locks.seal'), seal + '\n');
  await mkdir(join(agesHome(), 'sealed'), { recursive: true });
  await writeFile(backupFile(root), JSON.stringify({ project: resolve(root), seal, text }) + '\n');
}

/** ロックの記録が、人が最後に封印した内容と一致するか */
export async function verifyLocks(root: string): Promise<LockIntegrity> {
  const text = await readFile(join(root, '.ages', 'locks.json'), 'utf8').catch(() => null);
  const seal = (await readFile(join(root, '.ages', 'locks.seal'), 'utf8').catch(() => null))?.trim() ?? null;
  const key = await secret(false);
  let backup: LockIntegrity['backup'];
  if (key) {
    try {
      const b = JSON.parse(await readFile(backupFile(root), 'utf8'));
      if (hmac(key, b.text) === b.seal) backup = JSON.parse(b.text);
    } catch { /* 控えなし */ }
  }
  if (text === null) {
    if (backup && Object.keys(backup).length) return { ok: false, reason: 'ロックの記録（.ages/locks.json）が消されています', backup };
    return { ok: true };
  }
  if (!key || !seal) {
    const empty = Object.keys(JSON.parse(text || '{}')).length === 0;
    if (empty) return { ok: true };
    return { ok: false, reason: 'この端末では、まだ人がロックの記録を確認していません（Gitで取り込んだ直後など）', backup };
  }
  if (hmac(key, text) !== seal) return { ok: false, reason: 'ロックの記録が、人がロックマネージャーで設定した内容と一致しません（ロックマネージャー以外で書き換えられた可能性があります）', backup };
  return { ok: true, backup };
}

/** 現在の記録と控えの違い（エディタでの確認用） */
export function lockDiff(current: Record<string, { value: unknown }>, backup: Record<string, { value: unknown }> = {}) {
  const added = Object.keys(current).filter((k) => !(k in backup));
  const removed = Object.keys(backup).filter((k) => !(k in current));
  const changed = Object.keys(current).filter((k) => k in backup && JSON.stringify(current[k].value) !== JSON.stringify(backup[k].value));
  return { added, removed, changed };
}
