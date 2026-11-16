// ふるまいのロック: 決まった操作を再生した結果（見る値・出来事）を「正しい答え」として人がロックし、
// ages check・export のたびに再生して比べる。コードのどこを変えても、ショップなどの動きが変われば見つかる。
// 決まり（checks/名前.behave.json）は人も AI も書けるが、ロックした後に書き換えると、それも見つかる
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** ふるまいの決まり（ages run と同じ書き方） */
export interface BehaveSpec {
  desc: string;
  scene?: string;
  seed?: number;
  /** 入力（ages run --keys と同じ。例 "30-40:@confirm;90:click=buy"） */
  keys?: string;
  /** 始めのシーンに渡すもの（ages run --params と同じ） */
  params?: string;
  /** 始めの保存データ（プロジェクトの中のファイル） */
  save?: string;
  /** 日時（ages run --date と同じ） */
  date?: string;
  frames: number;
  /** 終わりに見る値（ages run --watch と同じ住所） */
  watch?: string[];
  /** 出来事（ctx.emit）の名前。出た順に、フレームと中身ごと比べる */
  log?: string[];
}

/** 再生した結果 */
export interface BehaveResult {
  watch: Record<string, unknown>;
  log: string[];
  /** ゲームのエラーで止まった */
  error?: string;
}

/** ロックに入れるもの（決まりの指紋と、そのときの結果） */
export interface BehaveLock { spec: string; result: BehaveResult }

export const BEHAVE_DIR = 'checks';
export const behavePath = (dir: string, name: string) => join(dir, BEHAVE_DIR, `${name}.behave.json`);
export const BEHAVE_NAME = /^[A-Za-z0-9_-]+$/;

/** ふるまいの決まりの名前（checks/*.behave.json） */
export async function behaveNames(dir: string): Promise<string[]> {
  const ents = await readdir(join(dir, BEHAVE_DIR)).catch(() => [] as string[]);
  return ents.filter((f) => f.endsWith('.behave.json')).map((f) => f.slice(0, -'.behave.json'.length)).sort();
}

/** 決まりを読む（形を確かめる）。text は指紋をとるための元の中身 */
export async function readBehave(dir: string, name: string): Promise<{ spec: BehaveSpec; text: string }> {
  const text = await readFile(behavePath(dir, name), 'utf8').catch(() => null);
  if (text === null) throw new Error(`ふるまい ${name} の決まり（${BEHAVE_DIR}/${name}.behave.json）がありません`);
  let spec: BehaveSpec;
  try { spec = JSON.parse(text); } catch (e) { throw new Error(`${BEHAVE_DIR}/${name}.behave.json: JSON として読めません: ${(e as Error).message}`); }
  const where = `${BEHAVE_DIR}/${name}.behave.json`;
  if (!spec || typeof spec !== 'object') throw new Error(`${where}: { desc, frames, keys?, watch?, log? } の形です`);
  if (typeof spec.desc !== 'string' || !spec.desc.trim()) throw new Error(`${where}: desc（何を確かめるか）がありません`);
  if (!Number.isInteger(spec.frames) || spec.frames < 1 || spec.frames > 100_000) throw new Error(`${where}: frames は 1〜100000 のフレーム数です`);
  for (const k of ['watch', 'log'] as const) if (spec[k] !== undefined && (!Array.isArray(spec[k]) || spec[k]!.some((x) => typeof x !== 'string'))) throw new Error(`${where}: ${k} は文字の並びです`);
  if (!spec.watch?.length && !spec.log?.length) throw new Error(`${where}: watch（終わりに見る値）か log（出来事の名前）のどちらかが要ります`);
  return { spec, text };
}

export const specHash = (text: string) => createHash('sha256').update(text).digest('hex');

/** 答えと今の結果の違い（なければ空） */
export function behaveDiff(want: BehaveResult, got: BehaveResult): string[] {
  const out: string[] = [];
  if ((want.error ?? '') !== (got.error ?? '')) out.push(`エラー: ${want.error ?? 'なし'} → ${got.error ?? 'なし'}`);
  const keys = [...new Set([...Object.keys(want.watch), ...Object.keys(got.watch)])];
  for (const k of keys) {
    const a = JSON.stringify(want.watch[k]), b = JSON.stringify(got.watch[k]);
    if (a !== b) out.push(`${k}: ${a ?? 'なし'} → ${b ?? 'なし'}`);
  }
  const n = Math.max(want.log.length, got.log.length);
  for (let i = 0; i < n; i++) {
    if (want.log[i] === got.log[i]) continue;
    out.push(`出来事 ${i + 1}番目: ${want.log[i] ?? 'なし'} → ${got.log[i] ?? 'なし'}（答え ${want.log.length}件・今 ${got.log.length}件）`);
    break;
  }
  return out;
}
