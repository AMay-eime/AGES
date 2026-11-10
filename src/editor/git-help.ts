// Git の出力から、よくある失敗を見分けて説明する（エディタの Git のパネル。エディタの言語で）。
// 英語の出力を読まなくても、何が起きて、何をすれば直るかが分かるように。直せるものは直す手（fix）も付ける

import { noTr, type Tr } from './i18n-node.ts';

export type GitOp = 'push' | 'pull' | 'commit' | 'sync';

/** 直す手（エディタのボタン。サーバーの /api/git/fix で行う） */
export type GitFix =
  | { kind: 'noreply' } // コミットのアドレスを GitHub の noreply にして、プッシュしていないコミットを作り直す
  | { kind: 'set-url'; url: string } // 送り先（origin）を新しい場所に
  | { kind: 'pushpull' } // コミット → 取り込み → プッシュ
  | { kind: 'set-upstream'; branch: string } // 枝の送り先を決めてプッシュ
  | { kind: 'identity' }; // コミットに入れる名前とアドレスを決める

export interface GitHelp {
  /** bad は失敗、warn は止まった（直せば進む）、info は知らせ（失敗ではない） */
  level: 'bad' | 'warn' | 'info';
  title: string;
  detail: string;
  fix?: GitFix;
}

/** 出力の中の、知っている失敗の説明（いくつも出ることがある。先頭がいちばん大事なもの）。tr はエディタの言語で訳す */
export function explainGit(op: GitOp, code: number, out: string, tr: Tr = noTr): GitHelp[] {
  const NAME: Record<GitOp, string> = { push: tr('プッシュ'), pull: tr('取り込み（プル）'), commit: tr('コミット'), sync: tr('GitHub との同期') };
  const helps: GitHelp[] = [];
  const has = (re: RegExp) => re.test(out);
  if (has(/GH007|push declined due to email privacy/i)) {
    helps.push({
      level: 'bad',
      title: tr('GitHub が、非公開にしているメールアドレスの入ったコミットを断りました'),
      detail: tr('GitHub の設定でメールアドレスを非公開にしていて、コミットにそのアドレスが入っています。公開してよい GitHub の noreply のアドレスに変えて、まだプッシュしていないコミットを作り直せば通ります（アドレスはコミットの中に入っているので、設定を変えるだけでは通りません）。'),
      fix: { kind: 'noreply' },
    });
  }
  if (has(/GH001|exceeds GitHub's file size limit|Large files detected/i)) {
    helps.push({
      level: 'bad',
      title: tr('GitHub に上げられない大きさのファイルがあります（1つ 100MB まで）'),
      detail: tr('そのファイルを Git に入れない（.gitignore に足す）か、Git LFS を使います。もうコミットしていれば、コミットから外す必要があります（AI に頼めます）。'),
    });
  }
  if (has(/Authentication failed|could not read (Username|Password)|Invalid username or (password|token)|Permission denied \(publickey\)|returned error: 403|terminal prompts disabled|denied to /i)) {
    helps.push({
      level: 'bad',
      title: tr('GitHub にログインできていないか、このリポジトリに書き込む権限がありません'),
      detail: tr('Windows なら、Git に付いている Git Credential Manager がログインの窓を出します。出ないときは、一度コマンドプロンプトでこのフォルダの git push を動かしてログインしてください（AI に頼めます）。人のリポジトリなら、書き込める人に招いてもらいます。'),
    });
  }
  if (has(/\[rejected\][^\n]*\((fetch first|non-fast-forward)\)|Updates were rejected because/i)) {
    helps.push({
      level: 'warn',
      title: tr('GitHub のほうが先に進んでいます（ほかの所からプッシュされた変更があります）'),
      detail: tr('先に GitHub の変更を取り込む必要があります。「取り込んでからプッシュ」で、コミット → 取り込み → プッシュ の順に行います。同じ所を両方で変えていたら、取り込みをやめて元に戻します。'),
      fix: { kind: 'pushpull' },
    });
  }
  const upstream = /git push --set-upstream (\S+) (\S+)/.exec(out);
  if (has(/has no upstream branch|no upstream configured|There is no tracking information/i)) {
    helps.push({
      level: 'warn',
      title: tr('この枝の送り先（GitHub の枝）が決まっていません'),
      detail: tr('初めてのプッシュです。送り先を決めてプッシュすると、次からはふつうのプッシュ・取り込みで行き来できます。'),
      ...(upstream ? { fix: { kind: 'set-upstream' as const, branch: upstream[2] } } : {}),
    });
  }
  if (has(/No configured push destination|does not appear to be a git repository|No such remote/i)) {
    helps.push({
      level: 'bad',
      title: tr('GitHub のリポジトリとつながっていません'),
      detail: tr('GitHub でリポジトリを作り、そのアドレスを送り先（origin）にします（AI に頼めます）。'),
    });
  }
  if (has(/Could not resolve host|Failed to connect to|Couldn't connect to server|Connection timed out|Connection reset|unable to access/i) && !helps.length) {
    helps.push({ level: 'bad', title: tr('GitHub につながりません'), detail: tr('ネットにつながっているかを確かめて、もう一度押してください。') });
  }
  if (has(/CONFLICT|Automatic merge failed/i)) {
    helps.push({
      level: 'bad',
      title: tr('手元の変更と GitHub の変更が、同じ所で食い違いました'),
      detail: tr('取り込みをやめて元に戻しました（手元の変更は残っています）。どちらを残すか決めて合わせる必要があります（AI に頼めます）。'),
    });
  }
  if (has(/Your local changes to the following files would be overwritten|Please commit your changes or stash them/i)) {
    helps.push({
      level: 'warn',
      title: tr('コミットしていない変更があるので、取り込めません'),
      detail: tr('先にコミットしてから取り込みます。「取り込んでからプッシュ」なら、コミット → 取り込み → プッシュ をまとめて行います。'),
      fix: { kind: 'pushpull' },
    });
  }
  if (has(/Please tell me who you are|unable to auto-detect email address|Author identity unknown/i)) {
    helps.push({
      level: 'warn',
      title: tr('コミットに入れる名前とメールアドレスが決まっていません'),
      detail: tr('コミットには名前とアドレスが入り、GitHub にプッシュすると誰でも見られます。アドレスを公開したくなければ、GitHub の noreply のアドレスにします。'),
      fix: { kind: 'identity' },
    });
  }
  const moved = /This repository moved\. Please use the new location:\s*(?:remote:\s*)?(\S+)/i.exec(out);
  if (moved) {
    helps.push({
      level: code === 0 ? 'info' : 'warn',
      title: tr('GitHub のリポジトリの場所（名前）が変わっています'),
      detail: tr('送り先を新しい場所（{0}）に直すと、この知らせは出なくなります。', moved[1]),
      fix: { kind: 'set-url', url: moved[1] },
    });
  }
  if (op === 'commit' && has(/nothing to commit|nothing added to commit|no changes added to commit/i)) {
    helps.push({ level: 'info', title: tr('コミットする変更がありません'), detail: tr('前のコミットから、何も変わっていません。') });
  }
  // 知っている失敗がなければ、出力を AI に見せるよう案内する（「変更がない」はそれだけで失敗ではない）
  if (code !== 0 && !helps.length) {
    helps.push({ level: 'bad', title: tr('{0}できませんでした', NAME[op]), detail: tr('Git のパネルの下に出た文を、そのまま AI に見せると直し方が分かります。') });
  }
  return helps;
}

/** 送り先の URL から GitHub の持ち主（ユーザー名の見当） */
export function githubOwner(url: string): string | null {
  return /github\.com[:/]([A-Za-z0-9-]+)\//i.exec(url)?.[1] ?? null;
}

/** GitHub の noreply のアドレス（ID は GitHub のユーザーの番号） */
export function noreplyEmail(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

/** 直す手で受け付ける送り先（空白や記号で git の引数を壊さない） */
export function safeRemoteUrl(url: string): boolean {
  return /^(https:\/\/[\w.-]+\/[\w.\/~-]+|git@[\w.-]+:[\w.\/~-]+)$/.test(url);
}
