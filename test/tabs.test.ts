// エディタのタブ（ブラウザ）: 閉じる・開き直す・畳む、別のウインドウに出す（中身は元のエディタのまま動く）・閉じると戻る
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, findChrome, freePort, kill, waitFor } from '../src/cli/shot.ts';

test('タブ: 閉じる・＋で開き直す・空のエリアは畳む・別のウインドウに出して戻す', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-tabs-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  const port = await freePort(), lock = await freePort();
  const ed = spawn(process.execPath, [new URL('../src/editor/server.ts', import.meta.url).pathname, dir, '--port', String(port), '--lock-port', String(lock), '--no-open'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const profile = await mkdtemp(join(tmpdir(), 'ages-tabs-chrome-'));
  let b: ReturnType<typeof spawn> | undefined;
  try {
    await waitFor('editor', 20_000, async () => (await fetch(`http://127.0.0.1:${port}/api/who`).then((r) => r.ok).catch(() => false)) || undefined);
    b = spawn(findChrome()!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    b.stderr!.on('data', (d) => { err += d; });
    const ws = await waitFor<string>('chrome', 20_000, async () => /DevTools listening on (ws:\/\/\S+)/.exec(err)?.[1]);
    const cdp = await Cdp.open(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${port}/?lang=ja` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    // userGesture: 人のクリックと同じ扱い（ブラウザは人の操作なしに新しいウインドウを開かない）
    const ev = async (expression: string, userGesture = false) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    await waitFor('editor page', 20_000, async () => ((await ev(`!!(window.ages && window.ages.registry && window.agesLayout)`)) ? true : undefined));
    await ev(`window.__errs = []; addEventListener('error', (e) => __errs.push(e.message))`);
    const tabs = (area: string) => ev(`[...document.querySelectorAll('.area[data-area=${area}] .tab')].map((x) => x.firstChild.textContent).join(',')`);
    const saved = async () => JSON.parse(await readFile(join(dir, '.ages', 'layout.json'), 'utf8'));

    // 閉じる（ゲームの画面は閉じられない）
    await ev(`agesLayout.close('git'); agesLayout.close('game')`);
    assert.doesNotMatch(await tabs('bottom'), /Git/);
    assert.match(await tabs('center'), /ゲーム/, 'ゲームの画面は閉じない');
    await waitFor('saved', 5000, async () => ((await saved().catch(() => null))?.closed?.includes('git') ? true : undefined));
    // ＋ から開き直す（その場所に）
    assert.equal(await ev(`!!document.querySelector('.area[data-area=left] .tab-add')`), true, '閉じたタブがあれば ＋');
    await ev(`document.querySelector('.area[data-area=left] .tab-add').click(); [...document.querySelectorAll('.menu div')].find((x) => x.textContent === 'Git').click()`);
    assert.match(await tabs('left'), /Git/);
    assert.equal(await ev(`!!document.querySelector('.tab-add')`), false, '閉じたタブがなければ ＋ は出ない');
    // 左のタブを全部閉じると畳む。開き直すと元の幅
    await ev(`for (const id of agesLayout.data.areas.left.slice()) agesLayout.close(id)`);
    assert.equal(await ev(`document.getElementById('work').style.getPropertyValue('--left')`), '30px');
    assert.equal(await ev(`document.querySelector('.area[data-area=left]').classList.contains('folded')`), true);
    await ev(`agesLayout.reopen('hierarchy')`);
    assert.equal(await ev(`document.getElementById('work').style.getPropertyValue('--left')`), '260px');

    // 別のウインドウに出す: 要素がそのまま移り、元のエディタの選び・キーがつながる
    await ev(`agesLayout.popOut('hierarchy')`, true);
    assert.equal(await ev(`agesLayout.isOut('hierarchy')`), true);
    assert.equal(await ev(`agesLayout.panels.get('hierarchy').el.ownerDocument !== document`), true, '別のウインドウの中にある');
    assert.equal(await ev(`document.querySelector('.area[data-area=left] .tab.out') !== null`), true, '元の場所には印のついたタブ');
    assert.equal(await ev(`[...agesLayout.out.get('hierarchy').win.document.styleSheets].length > 0`), true, '見た目も写す');
    // 別のウインドウで行をクリック → 元のエディタで選ばれる
    await ev(`[...agesLayout.panels.get('hierarchy').el.querySelectorAll('.item')].find((x) => x.textContent.includes('spawner')).click()`);
    assert.equal(await ev(`ages.selectedIds().join()`), 'spawner');
    // 別のウインドウのキー（Ctrl+A）も元のエディタの操作になる
    await ev(`agesLayout.out.get('hierarchy').win.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true }))`);
    assert.ok(await ev(`ages.selectedIds().length`) > 1, 'Ctrl+A ですべて選ぶ');
    // 元のウインドウが隠れていても、requestAnimationFrame は見えている別のウインドウの間合いで回る（時刻は元の時計）
    assert.equal(await ev(`(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      try { const t = await new Promise((r) => requestAnimationFrame(r)); return requestAnimationFrame(() => {}) < 0 && Math.abs(t - performance.now()) < 1000; }
      finally { delete document.visibilityState; }
    })()`), true);
    // document で待っているものにも、別のウインドウのマウスが届く
    assert.equal(await ev(`(() => { let n = 0; const f = () => n++; document.addEventListener('mouseup', f); agesLayout.out.get('hierarchy').win.dispatchEvent(new MouseEvent('mouseup')); document.removeEventListener('mouseup', f); return n; })()`), 1);
    // 閉じると元の場所へ戻る
    await ev(`agesLayout.out.get('hierarchy').win.close()`);
    await waitFor('docked', 5000, async () => ((await ev(`!agesLayout.isOut('hierarchy') && agesLayout.panels.get('hierarchy').el.ownerDocument === document`)) ? true : undefined));
    assert.match(await tabs('left'), /階層/);
    // 出していることは保存しない
    assert.equal(JSON.stringify(await saved()).includes('"out"'), false);
    assert.equal(await ev('JSON.stringify(__errs)'), '[]');
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
  } finally {
    if (b) kill(b);
    kill(ed);
    await rm(dir, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
});
