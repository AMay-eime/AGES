// 確認用のページ（ages export --review）: 再生は ages run と同じ入力で同じ状態になる・見本帳はプレハブと音を並べて1つずつ出す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdExport, cmdRun } = await import('../src/cli/ages.ts');
const { Cdp, findChrome, freePort, kill, waitFor } = await import('../src/cli/shot.ts');
const { serveStatic } = await import('../src/project/export.ts');

const KEYS = '0-40:@fire+@move_x=-1;40-90:@fire+@move_x=1;90-120:@fire';

async function copy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-review-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

test('ages export --review: review.json に再生（ages run と同じ書き方）と見本帳。付けなければ置かない', async () => {
  const dir = await copy();
  const out = await cmdExport(dir, { review: true, replay: KEYS, frames: '120', seed: '3' });
  assert.match(out, /確認用のページ（再生と見本帳）です。遊ぶ版・ストアに出す版は --review なしで書き出す/);
  const r = JSON.parse(await readFile(join(dir, 'dist', 'web', 'review.json'), 'utf8'));
  assert.deepEqual([r.replay.scene, r.replay.seed, r.replay.end], ['main', 3, 120]);
  assert.ok(r.replay.keys.events.length > 0);
  const kinds = Object.fromEntries(r.gallery.prefabs.map((x: { name: string; kind: string }) => [x.name, x.kind]));
  assert.equal(kinds.explosion, 'fx');
  assert.equal(kinds.se_shot, 'sound');
  assert.equal(kinds.enemy, 'thing');
  assert.ok(!('music' in kinds) || kinds.music !== undefined);
  assert.ok(r.gallery.sounds.includes('assets/sounds/bgm.wav'));
  await assert.rejects(cmdExport(dir, { review: true, scene: 'nope' }), /シーン nope はありません/);
  await assert.rejects(cmdExport(dir, { review: true, desktop: true }), /--review は Web だけ/);
  await cmdExport(dir, {});
  assert.ok(!existsSync(join(dir, 'dist', 'web', 'review.json')), 'ふつうの書き出しには入らない');
});

test('確認用のページ: 再生は止めるフレームで ages run と同じ hash・見本帳で押すと空の場面に出る（スマホの大きさ）', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = await copy();
  await cmdExport(dir, { review: true, replay: KEYS, frames: '120' });
  const want = /hash=(\w+)/.exec(await cmdRun(dir, { frames: '120', keys: KEYS }))![1];
  const port = await freePort();
  const server = await serveStatic(join(dir, 'dist', 'web'), port);
  const profile = await mkdtemp(join(tmpdir(), 'ages-review-chrome-'));
  const b = spawn(findChrome()!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--no-sandbox', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    let err = '';
    b.stderr!.on('data', (d) => { err += d; });
    const ws = await waitFor<string>('chrome', 20_000, async () => /DevTools listening on (ws:\/\/\S+)/.exec(err)?.[1]);
    const cdp = await Cdp.open(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html` }, sessionId);
    const ev = async (expression: string) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    // 速さ ×2 にして、止まるまで待つ
    await waitFor('再生', 20_000, async () => ((await ev(`!!window.agesPlayer?.started && document.querySelectorAll('button').length > 5`)) ? true : undefined));
    await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent === '×1').click()`);
    const end = await waitFor<{ frame: number; hash: string; error: string }>('止めるフレーム', 60_000, async () => { const s = await ev('window.agesPlayer'); return s.error || s.hash ? s : undefined; });
    assert.equal(end.error, '');
    assert.equal(end.frame, 120);
    assert.equal(end.hash, want, 'ages run と同じ状態');
    // 操作の帯の下にゲームがある（重ならない）
    const [barBottom, canvasTop] = await ev(`[document.querySelector('button').parentElement.getBoundingClientRect().bottom, document.getElementById('game').getBoundingClientRect().top]`);
    assert.ok(canvasTop >= barBottom - 0.5, `${canvasTop} >= ${barBottom}`);
    // コマ送り: 止まっていても1フレームずつ進む
    await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent === '▶|').click()`);
    await waitFor('コマ送り', 5_000, async () => ((await ev('window.agesPlayer.frame')) === 121 ? true : undefined));
    // 見本帳: explosion を押すと、空の場面に出る。一覧は下に出て、ゲームはその上
    await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent === '見本帳').click()`);
    await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'explosion').click()`);
    await waitFor('見本帳', 10_000, async () => { const s = await ev('window.agesPlayer'); return s.scene === '$tryout' && s.frame > 3 ? true : undefined; });
    const [canvasBottom, panelTop] = await ev(`[document.getElementById('game').getBoundingClientRect().bottom, [...document.querySelectorAll('button')].find((b) => b.textContent === 'explosion').closest('div[style*="overflow-y"]').getBoundingClientRect().top]`);
    assert.ok(canvasBottom <= panelTop + 0.5, `${canvasBottom} <= ${panelTop}`);
    assert.equal(await ev('window.agesPlayer.error'), '');
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
  } finally {
    kill(b);
    server.close();
  }
});
