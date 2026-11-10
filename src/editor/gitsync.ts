// エディタの GitHub との自動の取り込み（PLAN 57）。エディタを開いている間だけ、1分に1回ほど「変わったか」だけを聞く
// （git ls-remote で枝の先のコミットだけ。変わっていたときだけ取ってくる）。手元にプッシュしていない変更があれば、
// 勝手に取り込まず、プッシュしてから取り込むかを人に聞く。GitHub の利用規定（過剰な自動のアクセスをしない）に合わせる

import { noTr, type Tr } from './i18n-node.ts';

/** git を動かす（終わりのコードと出力） */
export type Git = (args: string[]) => Promise<{ code: number; out: string }>;

export interface RemoteState {
  /** 上流の枝（例 origin/main）。ないなら自動の取り込みは使えない */
  upstream: string | null;
  /** 上流の先のコミット（聞いた結果） */
  remoteHead?: string;
  /** 取り込んでいないコミットの数 */
  behind: number;
  /** プッシュしていないコミットの数 */
  ahead: number;
  /** コミットしていない変更のファイルの数（このプロジェクトの中） */
  dirty: number;
  /** 聞いた時刻 */
  checked: string;
  error?: string;
}

/** 上流が変わったかを聞き、変わっていれば取ってきて、手元との差を数える */
export async function remoteState(git: Git, now = new Date()): Promise<RemoteState> {
  const checked = now.toISOString();
  // 設定がないとき git は失敗する（出力はエラーの文なので、値として使わない）
  const value = async (a: string[]) => { const r = await git(a); return r.code === 0 ? r.out.trim() : ''; };
  const branch = await value(['branch', '--show-current']);
  const remote = branch ? await value(['config', `branch.${branch}.remote`]) : '';
  const merge = branch ? await value(['config', `branch.${branch}.merge`]) : '';
  const dirty = await dirtyCount(git);
  if (!branch || !remote || !merge) return { upstream: null, behind: 0, ahead: 0, dirty, checked };
  const upstream = `${remote}/${merge.replace(/^refs\/heads\//, '')}`;
  // 変わったかだけを聞く（枝の先のコミットだけが返る）
  const ls = await git(['ls-remote', remote, merge]);
  if (ls.code !== 0) return { upstream, behind: 0, ahead: 0, dirty, checked, error: firstLine(ls.out) };
  const remoteHead = ls.out.split(/\s/)[0] || undefined;
  const tracking = (await git(['rev-parse', '--verify', '-q', `refs/remotes/${upstream}`])).out.trim();
  if (remoteHead && remoteHead !== tracking) {
    const f = await git(['fetch', '-q', remote]);
    if (f.code !== 0) return { upstream, remoteHead, behind: 0, ahead: 0, dirty, checked, error: firstLine(f.out) };
  }
  const counts = (await git(['rev-list', '--left-right', '--count', `HEAD...refs/remotes/${upstream}`])).out.trim().split(/\s+/).map(Number);
  return { upstream, remoteHead, ahead: counts[0] || 0, behind: counts[1] || 0, dirty, checked };
}

/** コミットしていない変更（このプロジェクトの中）の数 */
export async function dirtyCount(git: Git): Promise<number> {
  return (await git(['status', '--porcelain', '--', '.'])).out.split('\n').filter(Boolean).length;
}

/**
 * 手元の変更をプッシュして、GitHub の変更も取り込む（人が選んだとき）。
 * GitHub に新しいコミットがあると先にプッシュできないので、コミット → 取り込み（合わせる）→ プッシュ の順。
 * 食い違い（同じ所を両方で変えた）があれば、取り込みをやめて元に戻し、プッシュしない
 */
export async function pushAndPull(git: Git, message: string, pull: (args: string[]) => Promise<{ code: number; out: string }> = git, tr: Tr = noTr): Promise<{ ok: boolean; out: string; conflict?: boolean; step: string }> {
  const log: string[] = [];
  if (await dirtyCount(git)) {
    const add = await git(['add', '-A', '--', '.']);
    const c = await git(['commit', '-m', message]);
    log.push(add.out, c.out);
    if (c.code !== 0) return { ok: false, out: log.filter(Boolean).join('\n'), step: 'commit' };
  }
  const p = await pull(['pull', '--no-rebase', '--no-edit']);
  log.push(p.out);
  if (p.code !== 0) {
    const conflict = /CONFLICT|Automatic merge failed|自動マージに失敗/.test(p.out);
    // 食い違いの印（<<<<<<<）が入ったままだと、JSON が読めずエディタも AI も止まるので、取り込みをやめて元に戻す（手元のコミットは残る）
    if (conflict) log.push((await git(['merge', '--abort'])).out, tr('（食い違ったので取り込みをやめました。手元の変更はコミット済みで、プッシュはしていません）'));
    return { ok: false, out: log.filter(Boolean).join('\n'), conflict, step: 'pull' };
  }
  const push = await git(['push']);
  log.push(push.out);
  return { ok: push.code === 0, out: log.filter(Boolean).join('\n'), step: push.code === 0 ? 'done' : 'push' };
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';
