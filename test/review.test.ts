// 確認用のページ（ages export --review）: 再生は ages run と同じ入力で同じ状態になる・見本帳はプレハブと音を並べて1つずつ出す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  // 見本帳は付けたときだけ（#157）
  const plain = await cmdExport(dir, { review: true, replay: KEYS, frames: '120' });
  assert.match(plain, /確認用のページ（再生）です/);
  assert.equal(JSON.parse(await readFile(join(dir, 'dist', 'web', 'review.json'), 'utf8')).gallery, undefined);
  await assert.rejects(cmdExport(dir, { review: true, gallery: 'nope' }), /--gallery の nope: /);
  const out = await cmdExport(dir, { review: true, replay: KEYS, frames: '120', seed: '3', gallery: 'all' });
  assert.match(out, /確認用のページ（再生・見本帳）です。遊ぶ版・ストアに出す版は --review なしで書き出す/);
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
  await cmdExport(dir, { review: true, replay: KEYS, frames: '120', gallery: 'explosion' });
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

test('案くらべ（--variants）: 値を変えた案を、今の値と並べて同じ入力で同時に再生する（issue #152）', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = await copy();
  await assert.rejects(cmdExport(dir, { review: true, replay: KEYS, frames: '120', variants: '[{"name":"x","set":{"main#player.Player.nope":1}}]' }), /--variants の x: /);
  await assert.rejects(cmdExport(dir, { review: true, variants: '[]' }), /1〜3 案/);
  await writeFile(join(dir, 'speed.variants.json'), JSON.stringify([{ name: '速い', set: { 'main#player.Player.speed': 9 } }, { name: '遅い', set: { 'main#player.Player.speed': 1 } }]));
  await cmdExport(dir, { review: true, replay: KEYS, frames: '120', variants: 'speed.variants.json' });
  const r = JSON.parse(await readFile(join(dir, 'dist', 'web', 'review.json'), 'utf8'));
  assert.deepEqual(r.variants.map((x: { name: string }) => x.name), ['速い', '遅い']);
  assert.ok(r.variants[0].scenes.main, '変わった文書だけ持つ');
  assert.deepEqual(Object.keys(r.variants[0].prefabs), []);
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true }, sessionId);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html` }, sessionId);
    const ev = async (expression: string) => {
      const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
      return res.result.value;
    };
    await waitFor('再生', 20_000, async () => ((await ev(`!!window.agesPlayer?.started && [...document.querySelectorAll('button')].some((b) => b.textContent === '案くらべ')`)) ? true : undefined));
    await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent === '案くらべ').click()`);
    await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent === '×1').click()`);
    const end = await waitFor<{ frame: number; hashes?: string[]; error: string }>('案くらべの終わり', 90_000, async () => { const s = await ev('window.agesPlayer'); return s.error || s.hashes ? s : undefined; });
    assert.equal(end.error, '');
    assert.equal(end.frame, 120);
    assert.equal(end.hashes!.length, 3, '今の値と2案');
    assert.equal(end.hashes![0], want, '今の値は ages run と同じ状態');
    assert.notEqual(end.hashes![1], end.hashes![0], '案の値で動きが変わる');
    assert.notEqual(end.hashes![2], end.hashes![1]);
    // 3つの画面が並び、本来の画面は隠れる
    const shown = await ev(`[...document.querySelectorAll('canvas')].filter((c) => c.id !== 'game' && c.getBoundingClientRect().width > 50).length`);
    assert.equal(shown, 3);
    assert.equal(await ev(`document.getElementById('game').style.visibility`), 'hidden');
    // 再生に戻ると、本来の画面に戻る
    await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent === '再生').click()`);
    assert.equal(await ev(`document.getElementById('game').style.visibility`), 'visible');
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
  } finally {
    kill(b);
    server.close();
  }
});

/** 書き出したページを headless の Chrome で開く */
async function openPage(dir: string, size = { width: 390, height: 844 }) {
  const port = await freePort();
  const server = await serveStatic(join(dir, 'dist', 'web'), port);
  const profile = await mkdtemp(join(tmpdir(), 'ages-review-chrome-'));
  const b = spawn(findChrome()!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--no-sandbox', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  b.stderr!.on('data', (d) => { err += d; });
  const ws = await waitFor<string>('chrome', 20_000, async () => /DevTools listening on (ws:\/\/\S+)/.exec(err)?.[1]);
  const cdp = await Cdp.open(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 2, mobile: true }, sessionId);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html` }, sessionId);
  const ev = async (expression: string) => {
    const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value;
  };
  const click = (label: string) => ev(`[...document.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
  const close = async () => { await cdp.send('Browser.close').catch(() => {}); cdp.close(); kill(b); server.close(); };
  return { ev, click, close };
}

test('区切り（--chapters）: 押すとそこから再生し、ages run と同じ状態になる。使うアセットだけ書き出し、.frag は置かない（#157 #160）', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = await copy();
  await assert.rejects(cmdExport(dir, { review: true, replay: KEYS, frames: '200', chapters: '[{"name":"x"}]' }), /params（場面をその値で始め直す）か frame/);
  await assert.rejects(cmdExport(dir, { review: true, replay: KEYS, frames: '200', chapters: '[{"name":"x","frame":300}]' }), /止めるフレーム/);
  const out = await cmdExport(dir, { review: true, replay: KEYS, frames: '200', chapters: '[{"name":"後半","frame":150},{"name":"値","params":{"level":2}}]' });
  assert.match(out, /確認用のページ（再生・区切り）/);
  assert.match(out, /アセットは再生で使う \d+個だけ（全部で \d+個/);
  const r = JSON.parse(await readFile(join(dir, 'dist', 'web', 'review.json'), 'utf8'));
  assert.ok(r.assets.includes('assets/kenney-pixel-shmup/ships.png'), JSON.stringify(r.assets));
  for (const a of r.assets) assert.ok(existsSync(join(dir, 'dist', 'web', a)), a);
  const all = (await cmdExport(dir, { review: true, replay: KEYS, frames: '200', assets: 'all' }));
  assert.doesNotMatch(all, /だけ（全部で/);
  // ゲームのシェーダーがあれば、.frag は書き出さない（中身は project.json にある）
  await writeFile(join(dir, 'assets', 'glow.frag'), '// 光る\nvec4 effect(vec4 c, vec2 uv) { return c; }\n');
  await cmdExport(dir, { review: true, replay: KEYS, frames: '200', chapters: '[{"name":"後半","frame":150},{"name":"値","params":{"level":2}}]' });
  assert.ok(!existsSync(join(dir, 'dist', 'web', 'assets', 'glow.frag')));
  assert.ok(JSON.parse(await readFile(join(dir, 'dist', 'web', 'project.json'), 'utf8')).assets.some((a: { path: string; shader?: unknown }) => a.path === 'assets/glow.frag' && a.shader));

  const want = /hash=(\w+)/.exec(await cmdRun(dir, { frames: '200', keys: KEYS }))![1];
  const wantP = /hash=(\w+)/.exec(await cmdRun(dir, { frames: '200', keys: KEYS, params: 'level=2' }))![1];
  const pg = await openPage(dir);
  try {
    await waitFor('再生', 20_000, async () => ((await pg.ev(`!!window.agesPlayer?.started && [...document.querySelectorAll('button')].some((b) => b.textContent === '後半')`)) ? true : undefined));
    assert.equal(await pg.ev(`[...document.querySelectorAll('button')].some((b) => b.textContent === '見本帳')`), false, '見本帳は付けたときだけ');
    for (const [label, hash] of [['後半', want], ['値', wantP]] as const) {
      await pg.click(label);
      const end = await waitFor<{ frame: number; hash?: string; error: string }>(`${label} の終わり`, 60_000, async () => { const s = await pg.ev('window.agesPlayer'); return s.error || s.hash ? s : undefined; });
      assert.equal(end.error, '');
      assert.equal(end.frame, 200);
      assert.equal(end.hash, hash, `${label}: ages run と同じ状態`);
    }
    assert.deepEqual(await pg.ev('window.agesPlayer.missing ?? []'), [], '再生で使うものは足りている');
  } finally {
    await pg.close();
  }
});
