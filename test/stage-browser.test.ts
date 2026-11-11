// 試しの舞台（api.stage）をブラウザで: 外して2秒たつと描く側（WebGL）を返し、戻したら新しい canvas で作り直して、また描ける（issue #123）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, findChrome, freePort, kill, waitFor } from '../src/cli/shot.ts';

test('試しの舞台: 2秒以上外してから戻しても、作り直してまた描ける。エラーの注記は読める色', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-stage-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  await writeFile(join(dir, 'editor', 'stage-probe.window.ts'), `import { defineWindow } from 'ages';
export default defineWindow({ id: 'stage-probe', title: '舞台', mount(el, api) {
  const host = api.h('div');
  el.append(host);
  (window as any).__stage = { host, el, handle: api.stage(host, { scene: 'main' }) };
} });
`);
  const cfgPath = join(dir, 'ages.project.json');
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  await writeFile(cfgPath, JSON.stringify({ ...cfg, editorWindows: [...cfg.editorWindows, 'editor/stage-probe.window.ts'] }, null, 2) + '\n');
  const port = await freePort(), lock = await freePort();
  const ed = spawn(process.execPath, [new URL('../src/editor/server.ts', import.meta.url).pathname, dir, '--port', String(port), '--lock-port', String(lock), '--no-open'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const profile = await mkdtemp(join(tmpdir(), 'ages-stage-chrome-'));
  let b: ReturnType<typeof spawn> | undefined;
  try {
    await waitFor('editor', 20_000, async () => (await fetch(`http://127.0.0.1:${port}/api/who`).then((r) => r.ok).catch(() => false)) || undefined);
    b = spawn(findChrome()!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900', '--no-sandbox', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    b.stderr!.on('data', (d) => { err += d; });
    const ws = await waitFor<string>('chrome', 20_000, async () => /DevTools listening on (ws:\/\/\S+)/.exec(err)?.[1]);
    const cdp = await Cdp.open(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${port}/?lang=ja` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const ev = async (expression: string) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    await waitFor('editor page', 20_000, async () => ((await ev(`!!(window.ages && window.ages.registry && window.agesLayout)`)) ? true : undefined));
    // 拡張の窓は読み込みの後に足される。足されたら前に出す
    await waitFor('stage', 20_000, async () => ((await ev(`window.__stage && agesLayout.panels.has('win:stage-probe') ? (agesLayout.move('win:stage-probe', 'bottom'), agesLayout.isVisible('win:stage-probe')) : false`)) ? true : undefined));
    // 描けているか: WebGL の canvas が失われていない・注記にエラーがない・画面を撮ると、舞台の真ん中がゲームの地の色（#0b0d1a）
    const { decodePng } = await import('../src/project/png.ts');
    const look = async () => {
      const l = await ev(`(() => {
        const c = __stage.host.querySelector('canvas'), r = c.getBoundingClientRect();
        const note = __stage.host.firstElementChild.lastElementChild;
        return { lost: c.getContext('webgl2').isContextLost(), note: note.textContent, bg: note.style.background, canvases: __stage.host.querySelectorAll('canvas').length, x: r.left + r.width / 2, y: r.top + r.height * 0.3 };
      })()`);
      const shot = decodePng(Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: l.x, y: l.y, width: 1, height: 1, scale: 1 } }, sessionId)).data, 'base64'));
      return { ...l, px: [...shot.data.subarray(0, 3)] };
    };
    const ground = [0x0b, 0x0d, 0x1a];
    const drawn = async (what: string) => waitFor(what, 15_000, async () => { const l = await look(); return !l.lost && !l.note && l.px.every((v: number, i: number) => Math.abs(v - ground[i]) <= 6) ? l : undefined; });
    const first = await drawn('最初に描ける');
    assert.equal(first.canvases, 2, 'WebGL と描き込みの2つ');

    // 外して 2.5 秒（2秒たつと WebGL を返す。フレームの数でなく時間で数える）。同じ所に戻す
    await ev(`window.__parent = __stage.host.parentNode; __stage.host.remove()`);
    await new Promise((r) => setTimeout(r, 2500));
    await ev(`__parent.append(__stage.host)`);
    const again = await drawn('戻したらまた描ける');
    assert.equal(again.canvases, 2, 'canvas は替わっても2つのまま');

    // エラーの注記は、地を付けて読めるように（--dim の色のままでない）
    await ev(`__stage.handle.set({ scene: 'nope' })`).catch(() => {});
    const bad = await waitFor('エラーの注記', 10_000, async () => { const l = await look(); return l.note ? l : undefined; });
    assert.notEqual(bad.bg, '', `エラーには地が付く: ${bad.note}`);
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
  } finally {
    if (b) kill(b);
    kill(ed);
  }
});
