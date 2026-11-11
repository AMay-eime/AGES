// 人と AI の共同作業の見える化（段階5。ブラウザ）: AI の作業が上に出る・AI の変更に印が付き、確かめる／戻す・
// AI の質問に答える・人の付箋が AI に届く・エディタの外で変わったファイルの差分・人が入力中の欄は AI が変えない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, findChrome, freePort, kill, waitFor } from '../src/cli/shot.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdPatch, cmdTalk, useActiveTask } = await import('../src/cli/ages.ts');
const { readTalk, foldTalk } = await import('../src/project/talk.ts');

test('AI とのやり取り: 作業・印・確かめる・戻す・質問・付箋・差分・入力中の欄', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-ai-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  const port = await freePort(), lock = await freePort();
  const ed = spawn(process.execPath, [new URL('../src/editor/server.ts', import.meta.url).pathname, dir, '--port', String(port), '--lock-port', String(lock), '--no-open'], { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
  const profile = await mkdtemp(join(tmpdir(), 'ages-ai-chrome-'));
  let b: ReturnType<typeof spawn> | undefined;
  // AI の操作（CLI と同じ: いまの作業の ID を付けてから）
  const ai = async <T>(fn: () => Promise<T>) => { await useActiveTask(dir); return fn(); };
  try {
    await waitFor('editor', 20_000, async () => (await fetch(`http://127.0.0.1:${port}/api/who`).then((r) => r.ok).catch(() => false)) || undefined);
    b = spawn(findChrome()!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    b.stderr!.on('data', (d) => { err += d; });
    const ws = await waitFor<string>('chrome', 20_000, async () => /DevTools listening on (ws:\/\/\S+)/.exec(err)?.[1]);
    const cdp = await Cdp.open(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${port}/?lang=ja` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId); // 画面なしでもフォーカスの出来事が来るように
    const ev = async (expression: string) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const until = (what: string, expr: string, ms = 8000) => waitFor(what, ms, async () => ((await ev(expr)) ? true : undefined));
    await until('editor page', `!!(window.ages && window.ages.registry && window.agesLayout)`, 20_000);
    await ev(`window.__errs = []; addEventListener('error', (e) => __errs.push(e.message)); window.confirm = () => true; agesLayout.show('ai')`);

    // 1. AI が作業を伝える → 上のバーと AI のパネルに出る
    await cmdTalk(dir, { task: '敵の体力を調整', steps: ['見る', '変える', '試す'], touch: ['@enemy'] });
    await until('task chip', `document.querySelector('.ai-chip')?.textContent.includes('敵の体力を調整 1/3')`);
    assert.match(await ev(`document.querySelector('.ai-panel').innerText`), /いまの作業[\s\S]*敵の体力を調整[\s\S]*見る/);

    // 2. AI が変える → 未確認の印（パネル・階層・インスペクタ）。触る予定の印も
    await ai(() => cmdPatch(dir, [{ op: 'set', path: '@enemy.Health.hp', value: 3 }], false));
    await until('unseen', `ages.ai.unseen().length === 1`);
    await ev(`ages.select({ kind: 'prefab', name: 'enemy' })`);
    await until('inspector mark', `document.querySelector('[data-ai="@enemy.Health.hp"]')?.classList.contains('ai-unseen')`);
    assert.equal(await ev(`(() => { const c = document.querySelector('[data-ai="@enemy"]').classList; return c.contains('ai-unseen') && c.contains('ai-touch'); })()`), true, '階層のプレハブにも（中の変更・触る予定）');
    assert.match(await ev(`document.querySelector('.ai-panel').innerText`), /AI の変更（確かめていない 1）[\s\S]*敵の体力を調整[\s\S]*@enemy\.Health\.hp/);
    // ✓ 見た → 印が消える（確かめたかは端末ごとに覚える）
    await ev(`[...document.querySelectorAll('.ai-panel button')].find((x) => x.textContent === '✓ 見た').click()`);
    await until('acked', `ages.ai.unseen().length === 0 && !document.querySelector('[data-ai="@enemy.Health.hp"]').classList.contains('ai-unseen')`);

    // 3. ↶ 戻す（作業ごと）
    await ai(() => cmdPatch(dir, [{ op: 'set', path: '@enemy.Health.hp', value: 9 }], false));
    await until('unseen again', `ages.ai.unseen().length === 1`);
    await ev(`[...document.querySelectorAll('.ai-panel button')].find((x) => x.textContent === '↶ 戻す').click()`);
    await waitFor('undone', 8000, async () => (JSON.parse(await readFile(join(dir, 'prefabs', 'enemy.prefab.json'), 'utf8')).components.Health.hp === 3 ? true : undefined));
    await until('undo acked', `ages.ai.unseen().length === 0`);

    // 4. AI の質問 → カードの選択肢で答える → AI が読める
    await cmdTalk(dir, { ask: '弾の速さはどちら？', choices: ['A 速め', 'B 遅め'], about: '@bullet' });
    await until('ask card', `document.querySelector('.ai-card.ask')?.innerText.includes('弾の速さはどちら？')`);
    assert.match(await ev(`document.querySelector('.ai-chip').textContent`), /❓1/);
    await ev(`[...document.querySelectorAll('.ai-card.ask button')].find((x) => x.textContent === 'B 遅め').click()`);
    await waitFor('answered', 5000, async () => (foldTalk(await readTalk(dir)).asks[0]?.answer?.text === 'B 遅め' ? true : undefined));
    assert.match(await cmdTalk(dir, {}), /→ B 遅め/);

    // 5. 人の付箋（選んでいる物に貼る）→ 階層に印 → AI が読み、返事をすると済む
    await ev(`(() => { const t = document.querySelector('.ai-compose textarea'); t.value = '敵が硬すぎる'; [...document.querySelectorAll('.ai-compose button')].find((x) => x.textContent.includes('貼る')).click(); })()`);
    await waitFor('note', 5000, async () => (foldTalk(await readTalk(dir)).notes[0]?.about === '@enemy' ? true : undefined));
    await until('note mark', `document.querySelector('[data-ai="@enemy"]').classList.contains('ai-note')`);
    const note = foldTalk(await readTalk(dir)).notes[0];
    assert.match(await cmdTalk(dir, {}), new RegExp(`${note.id} \\[@enemy\\] 敵が硬すぎる`));
    await cmdTalk(dir, { reply: note.id, text: '体力を 3 にしました' });
    await until('note done', `!document.querySelector('[data-ai="@enemy"]').classList.contains('ai-note') && ages.ai.openNotes().length === 0`);

    // 6. エディタの外で変わったファイル（計画書など）→ 差分を見る
    await writeFile(join(dir, 'NOTES.md'), '# メモ\n- 敵の体力を 3 に\n');
    await until('code change', `ages.ai.unseen().some((x) => x.kind === 'code' && x.change.path === 'NOTES.md')`);
    await ev(`[...document.querySelectorAll('.ai-panel button')].find((x) => x.textContent === '差分').click()`);
    await until('diff', `document.querySelector('.ai-diff')?.innerText.includes('+- 敵の体力を 3 に')`);

    // 7. 人が入力中の欄は、AI が変えない（入力をやめれば変えられる）。↶ で人が戻した値は ★（人が決めた値）なので force で
    await ev(`agesLayout.show('inspector'); document.querySelector('[data-path="@enemy.Health.hp"] input').focus()`);
    await new Promise((r) => setTimeout(r, 900));
    await assert.rejects(ai(() => cmdPatch(dir, [{ op: 'set', path: '@enemy.Health.hp', value: 5 }], true)), /入力中/);
    await ai(() => cmdPatch(dir, [{ op: 'set', path: '@bullet.Velocity.vy', value: -9 }], false)); // ほかの所は変えられる
    await ev(`document.activeElement.blur()`);
    await new Promise((r) => setTimeout(r, 900));
    await ai(() => cmdPatch(dir, [{ op: 'set', path: '@enemy.Health.hp', value: 5 }], true));

    await cmdTalk(dir, { done: '体力を 5 に' });
    await until('task done', `!document.querySelector('.ai-chip .ai-task')`);
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
