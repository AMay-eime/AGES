// 決まったフレームの画面を撮る（ages run --shot）。依存ゼロ: 手元の Chrome（Chromium・Edge でもよい）を headless で起こし、
// DevTools の決まり（CDP）で操作する。ページはエディタのサーバーの /shot.html（editor/shot.ts）。
// GPU に左右されないよう、描画はいつもソフトウェア（SwiftShader）で行う（同じ入力なら同じ画）。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ShotConfig, ShotResult } from '../editor/shot.ts';

/** Chrome の場所。AGES_CHROME（環境変数）→ PATH の名前 → よくある場所 → Playwright が入れたもの */
export function findChrome(): string | null {
  const env = process.env.AGES_CHROME;
  if (env && existsSync(env)) return env;
  const names = process.platform === 'win32' ? ['chrome.exe', 'msedge.exe'] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'microsoft-edge'];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  const fixed = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : process.platform === 'win32'
      ? [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap((b) => [join(b!, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(b!, 'Microsoft', 'Edge', 'Application', 'msedge.exe')])
      : [];
  for (const f of fixed) if (existsSync(f)) return f;
  // Playwright の置き場所（chromium-NNNN/chrome-linux64/chrome など）
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), '.cache', 'ms-playwright'), join(homedir(), 'Library', 'Caches', 'ms-playwright'), join(homedir(), 'AppData', 'Local', 'ms-playwright')]) {
    if (!root || !existsSync(root)) continue;
    for (const d of readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
        const f = join(root, d, sub);
        if (existsSync(f)) return f;
      }
    }
  }
  return null;
}

/** 空いているポート（すぐ閉じて番号だけ使う） */
export function freePort(): Promise<number> {
  return new Promise((ok, ng) => {
    const s = createServer();
    s.once('error', ng);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

export async function waitFor<T>(what: string, ms: number, f: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what}が ${ms / 1000} 秒たっても始まりません${last ? `（${(last as Error).message}）` : ''}`);
}

/** CDP（DevTools の決まり）で1つのページを動かす最小の口 */
export class Cdp {
  private id = 0;
  private wait = new Map<number, { ok: (v: any) => void; ng: (e: Error) => void }>();
  private ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      const w = m.id !== undefined ? this.wait.get(m.id) : undefined;
      if (!w) return;
      this.wait.delete(m.id);
      m.error ? w.ng(new Error(m.error.message)) : w.ok(m.result);
    });
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((ok, ng) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => ok(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => ng(new Error('Chrome の DevTools につながりません')), { once: true });
    });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((ok, ng) => this.wait.set(id, { ok, ng }));
  }
  close(): void {
    this.ws.close();
  }
}

export const kill = (p: ChildProcess | undefined) => { try { p?.kill(); } catch { /* もう止まっている */ } };

/**
 * プロジェクトをエディタのサーバーで開き、headless の Chrome で /shot.html を開いて、決まったフレームの画面を撮る。
 * Chrome がなければエラー（AGES_CHROME で場所を指定できる）
 */
export async function captureShots(dir: string, cfg: ShotConfig, timeoutMs = 120_000): Promise<ShotResult> {
  const chrome = findChrome();
  if (!chrome) throw new Error('画面を撮るには Chrome（Chromium・Edge でもよい）が要ります。見つからないときは、環境変数 AGES_CHROME に場所を書いてください');
  const port = await freePort();
  const lockPort = await freePort();
  const serverTs = fileURLToPath(new URL('../editor/server.ts', import.meta.url));
  let server: ChildProcess | undefined;
  let browser: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  const profile = await mkdtemp(join(tmpdir(), 'ages-shot-'));
  try {
    server = spawn(process.execPath, [serverTs, dir, '--port', String(port), '--lock-port', String(lockPort), '--no-open'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let serverErr = '';
    server.stderr?.on('data', (d) => { serverErr += String(d); });
    const base = `http://127.0.0.1:${port}`;
    await waitFor('エディタのサーバー', 30_000, async () => {
      if (server!.exitCode !== null) throw new Error(serverErr.trim() || 'サーバーが止まりました');
      const r = await fetch(`${base}/api/state`);
      return r.ok ? true : undefined;
    });

    browser = spawn(chrome, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--mute-audio', '--hide-scrollbars', '--disable-background-timer-throttling',
      // 描画はいつもソフトウェアで（GPU の違いで画が変わらないように）
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl',
      // root で動かすとき（コンテナなど）は、Chrome の決まりで sandbox を外さないと起きない
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let chromeErr = '';
    browser.stderr?.on('data', (d) => { chromeErr += String(d); });
    const wsUrl = await waitFor<string>('Chrome', 30_000, async () => {
      if (browser!.exitCode !== null) throw new Error(chromeErr.trim().split('\n').slice(-3).join(' ') || 'Chrome が止まりました');
      return /DevTools listening on (ws:\/\/\S+)/.exec(chromeErr)?.[1];
    });
    cdp = await Cdp.open(wsUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: `${base}/shot.html` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const evaluate = async (expression: string) => {
      const r = await cdp!.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    await waitFor('撮るページ', 30_000, async () => ((await evaluate(`typeof window.agesShot === 'function'`)) ? true : undefined));
    const run = evaluate(`window.agesShot(${JSON.stringify(cfg)})`) as Promise<ShotResult>;
    const timer = new Promise<never>((_, ng) => setTimeout(() => ng(new Error(`画面を撮るのが ${timeoutMs / 1000} 秒で終わりません`)), timeoutMs).unref());
    return await Promise.race([run, timer]);
  } finally {
    try { await cdp?.send('Browser.close'); } catch { /* 閉じている */ }
    cdp?.close();
    kill(browser);
    kill(server);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
