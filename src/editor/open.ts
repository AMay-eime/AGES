// エディタを開く: 空いているポートを選ぶ・同じプロジェクトのエディタがもう動いていればそれを開く・ブラウザで開く。
// PC に慣れていない人が、ポートの番号やアドレスを打たずに使えるように（ダブルクリックの起動用・AI が起動したときも同じ）。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

/** 初めに試すポート（エディタ。ロックマネージャーはその次の番号） */
export const DEFAULT_PORT = 5170;

/** 同じフォルダか（Windows・mac は大文字と小文字を区別しないことが多い） */
export function sameDir(a: string, b: string, platform = process.platform): boolean {
  const n = (p: string) => { const r = resolve(p).replace(/[\\/]+$/, ''); return platform === 'linux' ? r : r.toLowerCase(); };
  return n(a) === n(b);
}

/**
 * エディタとロックマネージャーのポートを選ぶ。start と start+1 が空いていればそれ。
 * 使われていて、同じプロジェクトのエディタが動いているなら、それを使う（running: true。新しく起動しない）。
 * ほかのプロジェクトのエディタなどが使っていれば、2つ先へ
 */
export async function choosePort(projectDir: string, opts: { start?: number; tries?: number; isFree?: (port: number) => Promise<boolean>; whoIs?: (port: number) => Promise<string | null> } = {}): Promise<{ port: number; running: boolean }> {
  const start = opts.start ?? DEFAULT_PORT, tries = opts.tries ?? 20;
  const free = opts.isFree ?? isFree, who = opts.whoIs ?? whoIs;
  for (let i = 0; i < tries; i++) {
    const port = start + i * 2;
    if ((await free(port)) && (await free(port + 1))) return { port, running: false };
    const dir = await who(port);
    if (dir && sameDir(dir, projectDir)) return { port, running: true };
  }
  throw new Error(`エディタに使えるポートが見つかりません（${start}〜${start + tries * 2 - 1}）。--port で番号を決めてください`);
}

/** そのポートが空いているか（エディタと同じく、すべての宛先で聞けるか） */
export function isFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once('error', () => ok(false));
    s.listen(port, () => s.close(() => ok(true)));
  });
}

/** そのポートで動いている AGES のエディタのプロジェクト（AGES のエディタでなければ null） */
export async function whoIs(port: number): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/who`, { signal: AbortSignal.timeout(1500) });
    const j = (await r.json()) as { app?: string; project?: string };
    return j.app === 'ages-editor' && typeof j.project === 'string' ? j.project : null;
  } catch {
    return null;
  }
}

/** ブラウザで開くか: --no-open・環境変数 AGES_NO_OPEN・CI のときは開かない（エディタを中で使う ages run --shot なども --no-open） */
export function shouldOpen(args: string[], env: Record<string, string | undefined> = process.env): boolean {
  if (args.includes('--no-open')) return false;
  if (args.includes('--open')) return true;
  return !env.AGES_NO_OPEN && !env.CI;
}

/** アプリの窓（アドレスのバーがない）で開ける、Windows の Chrome か Edge（Edge は Windows 10・11 に入っている） */
export function findAppBrowser(env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync): string | null {
  const bases = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter((b): b is string => !!b);
  const list = [...bases.map((b) => join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')), ...bases.map((b) => join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))];
  return list.find((f) => exists(f)) ?? null;
}

/** 開くための命令。Windows は Chrome・Edge のアプリの窓（なければ既定のブラウザ）、mac は既定のブラウザ、ほかは xdg-open */
export function browserCommand(url: string, platform: string = process.platform, app: string | null = platform === 'win32' ? findAppBrowser() : null): { cmd: string; args: string[]; verbatim?: boolean } {
  if (platform === 'win32') return app ? { cmd: app, args: [`--app=${url}`] } : { cmd: 'cmd', args: ['/c', 'start', '""', url], verbatim: true };
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

/** ブラウザで開く（開けなくても止めない。アドレスは画面にも出している） */
export function openBrowser(url: string): void {
  const c = browserCommand(url);
  try {
    const child = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', windowsHide: true, ...(c.verbatim ? { windowsVerbatimArguments: true } : {}) });
    child.on('error', () => {});
    child.unref();
  } catch { /* 開けない環境（画面のないサーバーなど） */ }
}
