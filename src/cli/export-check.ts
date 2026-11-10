// 書き出したもの（Web）が動くかを確かめる（ages export --check）。書き出したフォルダを小さなサーバーで配り、
// headless の Chrome で開いて、決まった秒数だけ進むか・エラーが出ないかを見る（ages run --shot と同じ Chrome の起こし方）
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, findChrome, freePort, kill, waitFor } from './shot.ts';
import { serveStatic } from '../project/export.ts';

export interface ExportCheck {
  ok: boolean;
  frame: number;
  scene: string;
  error: string;
}

/** 書き出した Web のフォルダを開き、frames フレーム進むまで待つ */
export async function checkExport(web: string, frames: number, timeoutMs = 90_000): Promise<ExportCheck> {
  const chrome = findChrome();
  if (!chrome) throw new Error('確かめるには Chrome（Chromium・Edge でもよい）が要ります。見つからないときは、環境変数 AGES_CHROME に場所を書いてください');
  const port = await freePort();
  const server = await serveStatic(web, port);
  const profile = await mkdtemp(join(tmpdir(), 'ages-export-'));
  let browser: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    browser = spawn(chrome, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--mute-audio', '--hide-scrollbars', '--disable-background-timer-throttling',
      // 音を人の操作なしで始められるように（「はじめる」を押さずに進める）
      '--autoplay-policy=no-user-gesture-required',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1280,720',
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
    const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${port}/index.html` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const status = async () => {
      const r = await cdp!.send('Runtime.evaluate', { expression: 'JSON.stringify(window.agesPlayer ?? null)', returnByValue: true }, sessionId);
      return JSON.parse(r.result.value ?? 'null') as { ready: boolean; frame: number; scene: string; error: string; started: boolean } | null;
    };
    let last = { frame: 0, scene: '', error: '' };
    try {
      await waitFor('書き出したゲーム', timeoutMs, async () => {
        const s = await status();
        if (!s) return undefined;
        last = s;
        if (s.error) return true;
        return s.frame >= frames ? true : undefined;
      });
    } catch (e) {
      if (!last.error) last.error = (e as Error).message;
    }
    return { ok: !last.error && last.frame >= frames, frame: last.frame, scene: last.scene, error: last.error };
  } finally {
    try { await cdp?.send('Browser.close'); } catch { /* 閉じている */ }
    cdp?.close();
    kill(browser);
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
