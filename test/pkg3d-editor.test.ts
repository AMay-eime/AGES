// 追加パッケージ 3d のエディタ（ブラウザ）: 「3D シーン」パネルが出る・クリックで選ぶ・ギズモで動かす／回す／大きさを変える（保存され、元に戻せる）・
// 視点を回す／寄る・形を足す。2D のプロジェクトには出ない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, findChrome, freePort, kill, waitFor } from '../src/cli/shot.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdInit, cmdPatch } = await import('../src/cli/ages.ts');

async function open(dir: string, fn: (page: { ev(expr: string): Promise<any>; until(what: string, expr: string): Promise<unknown>; mouse(type: string, x: number, y: number, o?: Record<string, unknown>): Promise<void>; key(key: string, code: string, vk: number): Promise<void> }) => Promise<void>): Promise<void> {
  const port = await freePort(), lock = await freePort();
  const ed = spawn(process.execPath, [new URL('../src/editor/server.ts', import.meta.url).pathname, dir, '--port', String(port), '--lock-port', String(lock), '--no-open'], { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
  const profile = await mkdtemp(join(tmpdir(), 'ages-3de-chrome-'));
  let b: ReturnType<typeof spawn> | undefined;
  try {
    await waitFor('editor', 20_000, async () => (await fetch(`http://127.0.0.1:${port}/api/who`).then((r) => r.ok).catch(() => false)) || undefined);
    b = spawn(findChrome()!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    b.stderr!.on('data', (d) => { err += d; });
    const ws = await waitFor<string>('chrome', 20_000, async () => /DevTools listening on (ws:\/\/\S+)/.exec(err)?.[1]);
    const cdp = await Cdp.open(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = []; addEventListener('error', (e) => __errs.push(e.message)); addEventListener('unhandledrejection', (e) => __errs.push(String(e.reason)));` }, sessionId);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=ja` }, sessionId);
    const ev = async (expression: string) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const until = (what: string, expr: string) => waitFor(what, 10_000, async () => ((await ev(expr)) ? true : undefined));
    const mouse = async (type: string, x: number, y: number, o: Record<string, unknown> = {}) => { await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...o }, sessionId); };
    const key = async (k: string, code: string, vk: number) => { for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk }, sessionId); };
    await until('editor page', `!!(window.ages && window.ages.registry && window.agesLayout)`);
    await fn({ ev, until, mouse, key });
    assert.equal(await ev('JSON.stringify(__errs)'), '[]');
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
  } finally {
    if (b) kill(b);
    kill(ed);
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
}

test('3D シーン: 選ぶ・動かす・回す・大きさ・視点・足す', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-3de-')), 'g');
  await cmdInit(dir, 'g');
  const cfg = join(dir, 'ages.project.json');
  await writeFile(cfg, JSON.stringify({ ...JSON.parse(await readFile(cfg, 'utf8')), packages: ['3d'] }, null, 2) + '\n');
  const ent = (id: string, components: Record<string, Record<string, unknown>>) => ({ op: 'addEntity' as const, scene: 'main', entity: { id, components } });
  await cmdPatch(dir, [
    ent('ground', { Transform3D: {}, Mesh3D: { shape: 'plane', size: [20, 1, 20] } }),
    ent('box', { Transform3D: { x: -2, y: 0.5 }, Mesh3D: { shape: 'box' } }),
    ent('ball', { Transform3D: { x: 2, y: 0.5 }, Mesh3D: { shape: 'sphere' } }),
    ent('lamp', { Transform3D: { y: 3 }, Light3D: { kind: 'point' } }),
  ], false);
  const saved = async (id: string) => JSON.parse(await readFile(join(dir, 'scenes', 'main.scene.json'), 'utf8')).entities.find((e: { id: string }) => e.id === id)?.components.Transform3D;
  await open(dir, async ({ ev, until, mouse, key }) => {
    await until('scene3d', `agesLayout.data.active.center === 'scene3d' && !!ages.scene3d && ages.scene3d.canvas.width > 100 && !!ages.scene3d.screenOf('ball')`);
    // 配置が落ち着くまで待つ（起動の直後は、パネルの並べ直しで位置が動く）
    for (let prev = '', same = 0; same < 3;) {
      await new Promise((r) => setTimeout(r, 250));
      const now = JSON.stringify(await ev(`ages.scene3d.screenOf('ball')`));
      same = now === prev ? same + 1 : 0;
      prev = now;
    }
    const click = async (p: { x: number; y: number }) => { await mouse('mouseMoved', p.x, p.y, { buttons: 0 }); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y); };
    const dragBy = async (p: { x: number; y: number }, dx: number, dy: number, o: Record<string, unknown> = {}) => {
      await mouse('mouseMoved', p.x, p.y, { buttons: 0 });
      await new Promise((r) => setTimeout(r, 120));
      await mouse('mousePressed', p.x, p.y, o);
      for (let i = 1; i <= 6; i++) await mouse('mouseMoved', p.x + (dx * i) / 6, p.y + (dy * i) / 6, o);
      await mouse('mouseReleased', p.x + dx, p.y + dy, o);
    };
    // 形のある物・形のない物（光の印）をクリックで選ぶ。何もない所で外れる
    await click(await ev(`ages.scene3d.screenOf('ball')`));
    await until('ball', `ages.selectedIds().join() === 'ball'`);
    await click(await ev(`ages.scene3d.screenOf('lamp')`));
    await until('lamp', `ages.selectedIds().join() === 'lamp'`);
    await click(await ev(`ages.scene3d.screenOf('box')`));
    await until('box', `ages.selectedIds().join() === 'box'`);

    // 動かす: x の取っ手を軸の向きへ引く → x だけ増えて保存される
    await new Promise((r) => setTimeout(r, 500));
    const o = await ev(`ages.scene3d.screenOf('box')`), hx = await ev(`ages.scene3d.handleAt(0)`);
    await dragBy(hx, hx.x - o.x, hx.y - o.y);
    await waitFor('moved', 8000, async () => ((await saved('box'))?.x > -2 ? true : undefined));
    const t1 = await saved('box');
    assert.ok(t1.x > -1 && t1.x < 0.5, `取っ手の長さくらい（約 1.9m）x の向きへ動く: ${JSON.stringify(t1)}`);
    assert.deepEqual([t1.y, t1.z ?? 0], [0.5, 0]);
    // 元に戻せる
    await ev(`ages.undo()`);
    await waitFor('undone', 8000, async () => ((await saved('box'))?.x === -2 ? true : undefined));

    // 回す（E）: y の輪を引く → ry だけ変わる。Ctrl で 15 度刻み
    await ev(`document.querySelector('[tabindex="0"]').focus()`);
    await key('e', 'KeyE', 69);
    await new Promise((r) => setTimeout(r, 200));
    const ring = await ev(`ages.scene3d.handleAt(1, 0.125)`), ring2 = await ev(`ages.scene3d.handleAt(1, 0.25)`);
    await dragBy(ring, ring2.x - ring.x, ring2.y - ring.y, { modifiers: 2 });
    await waitFor('rotated', 8000, async () => ((await saved('box'))?.ry ? true : undefined));
    const t2 = await saved('box');
    assert.ok(t2.ry % 15 === 0 && t2.ry !== 0 && !t2.rx && !t2.rz, JSON.stringify(t2));

    // 大きさ（R）: 真ん中の取っ手で全体
    await key('r', 'KeyR', 82);
    await new Promise((r) => setTimeout(r, 200));
    await dragBy(await ev(`ages.scene3d.screenOf('box')`), 75, 0);
    await waitFor('scaled', 8000, async () => ((await saved('box'))?.sx > 1 ? true : undefined));
    const t3 = await saved('box');
    assert.ok(t3.sx === t3.sy && t3.sy === t3.sz && Math.abs(t3.sx - 1.5) < 0.05, JSON.stringify(t3));

    // 視点: 右ドラッグで回る・ホイールで寄る
    const yaw = await ev(`ages.scene3d.view.yaw`), dist = await ev(`ages.scene3d.view.dist`);
    await dragBy({ x: 700, y: 300 }, 80, 0, { button: 'right', buttons: 2 });
    assert.notEqual(await ev(`ages.scene3d.view.yaw`), yaw);
    await mouse('mouseWheel', 700, 300, { deltaX: 0, deltaY: -300, buttons: 0 });
    assert.ok((await ev(`ages.scene3d.view.dist`)) < dist);

    // 足す: 箱
    await ev(`[...document.querySelectorAll('.toolbar button')].find((x) => x.textContent === '＋ 足す').click()`);
    await ev(`[...document.querySelectorAll('.menu div')].find((x) => x.textContent === '箱').click()`);
    await waitFor('added', 8000, async () => ((await saved('box2')) ? true : undefined));
    assert.equal(await ev(`ages.selectedIds().join()`), 'box2');

    // 当たり判定を、選んだ物の形に合わせて付ける（球なら球・同じ太さ）
    const collider = async (id: string) => JSON.parse(await readFile(join(dir, 'scenes', 'main.scene.json'), 'utf8')).entities.find((e: { id: string }) => e.id === id)?.components.Collider3D;
    await ev(`ages.select({ kind: 'scene', scene: 'main', id: 'ball' })`);
    await ev(`[...document.querySelectorAll('.toolbar button')].find((x) => x.textContent === '＋ 足す').click()`);
    await ev(`[...document.querySelectorAll('.menu div')].find((x) => x.textContent === '当たり判定を、選んだ物の形に合わせて付ける').click()`);
    await waitFor('collider', 8000, async () => ((await collider('ball')) ? true : undefined));
    assert.deepEqual(await collider('ball'), { shape: 'sphere', size: [1, 1, 1] });
    // 床（板）は薄い箱に。上の面が床の高さに合う
    await ev(`ages.select({ kind: 'scene', scene: 'main', id: 'ground' })`);
    await ev(`ages.scene3d.fitCollider()`);
    await waitFor('collider', 8000, async () => ((await collider('ground')) ? true : undefined));
    assert.deepEqual(await collider('ground'), { shape: 'box', size: [20, 0.2, 20], offset: [0, -0.1, 0] });
  });
});

test('2D のプロジェクトには 3D シーンのパネルは出ない', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-3de-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  await open(dir, async ({ ev }) => {
    assert.equal(await ev(`agesLayout.panels.has('scene3d') || !!ages.scene3d`), false);
  });
});
