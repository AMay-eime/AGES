// 表のエディタ（ブラウザ）: 並べ替えたあと別の表に替えても落ちない（#94）。並べ替えは表ごとに覚える
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, findChrome, freePort, kill, waitFor } from '../src/cli/shot.ts';

test('表のエディタ: 並べ替えた列がない表に替えても、中身がその表になる・戻ると並べ替えが残る', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-tbl-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  const port = await freePort(), lock = await freePort();
  const ed = spawn(process.execPath, [new URL('../src/editor/server.ts', import.meta.url).pathname, dir, '--port', String(port), '--lock-port', String(lock), '--no-open'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const profile = await mkdtemp(join(tmpdir(), 'ages-tbl-chrome-'));
  let b: ReturnType<typeof spawn> | undefined;
  try {
    await waitFor('editor', 20_000, async () => (await fetch(`http://127.0.0.1:${port}/api/who`).then((r) => r.ok).catch(() => false)) || undefined);
    b = spawn(findChrome()!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    b.stderr!.on('data', (d) => { err += d; });
    const ws = await waitFor<string>('chrome', 20_000, async () => /DevTools listening on (ws:\/\/\S+)/.exec(err)?.[1]);
    const cdp = await Cdp.open(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${port}/` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const ev = async (expression: string) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
    await waitFor('editor page', 20_000, async () => ((await ev(`!!(window.ages && window.ages.registry)`)) ? true : undefined));
    await ev(`window.__errs = []; addEventListener('error', (e) => __errs.push(e.message))`);
    const heads = () => ev(`[...document.querySelectorAll('.table-grid th')].map((x) => x.textContent.trim()).join(',')`);
    const choose = (t: string) => ev(`(() => { const s = document.querySelector('.table-ed select'); s.value = ${JSON.stringify(t)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
    await ev(`ages.emit('openTable', { name: 'enemies' })`);
    await waitFor('enemies', 5000, async () => (/hp/.test(await heads()) ? true : undefined));
    await ev(`[...document.querySelectorAll('.table-grid th')].find((x) => x.textContent.trim() === 'hp').click()`);
    assert.match(await heads(), /hp ▲/);
    await choose('actions');
    await waitFor('actions', 5000, async () => (/kind/.test(await heads()) ? true : undefined));
    assert.doesNotMatch(await heads(), /hp/, '中身も新しい表になる');
    assert.equal(await ev('JSON.stringify(__errs)'), '[]');
    await choose('enemies');
    await waitFor('enemies again', 5000, async () => (/hp/.test(await heads()) ? true : undefined));
    assert.match(await heads(), /hp ▲/, '戻ると、その表の並べ替えに戻る');
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
  } finally {
    if (b) kill(b);
    kill(ed);
    await rm(dir, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
});
