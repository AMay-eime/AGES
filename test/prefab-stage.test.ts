// エディタのプレハブの編集画面（issue #130 の段2）: 親と子がそろった仮のシーン・子の値をインスペクタで直す・親は動かせない・まつわる表の値
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdInit, cmdPatch } = await import('../src/cli/ages.ts');
const { Cdp, findChrome, freePort, kill, waitFor } = await import('../src/cli/shot.ts');
const { stageScene, STAGE_ROOT } = await import('../src/editor/app.ts');

const SHIP = {
  gun: { name: 'gun', components: { Transform: {}, Shape: { kind: 'rect', w: 6, h: 12, color: '#888888' } }, children: [{ name: 'muzzle', components: { Transform: { y: -8 }, Shape: { kind: 'circle', w: 4, h: 4 } } }] },
  ship: { name: 'ship', components: { Transform: {}, Shape: { kind: 'rect', w: 16, h: 16 } }, children: [{ name: 'gun_l', prefab: 'gun', components: { Transform: { x: -12 } } }, { name: 'core', components: { Shape: { kind: 'circle', w: 4, h: 4 } } }] },
};

test('仮のシーン: 親は $root、子と孫は $root/子（子にしたプレハブの名前を添える）、2D は見るためのカメラ', () => {
  const s = stageScene(SHIP as any, 'ship');
  assert.deepEqual(s.entities.map((e) => [e.id, e.name, (e.components.Transform as { parent?: string } | undefined)?.parent ?? null]), [
    [STAGE_ROOT, '@ship', null], ['$root/gun_l', 'gun_l ←@gun', STAGE_ROOT], ['$root/gun_l/muzzle', 'muzzle', '$root/gun_l'], ['$root/core', 'core', STAGE_ROOT], ['$camera', '（見るためのカメラ）', null],
  ]);
  assert.equal((s.entities[1].components.Transform as { x: number }).x, -12);
  assert.ok(!('prefab' in s.entities[1]), '子にしたプレハブとは重ね済み（二重に重ねない）');
});

test('エディタ: 開くと親と子が出て、子の値を直すとプレハブのファイルの子に入る。親は動かせない。まつわる表の値', { skip: findChrome() ? false : 'Chrome がない' }, async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-pstage-')), 'g');
  await cmdInit(dir, 'g', 'none');
  await writeFile(join(dir, 'game', 'index.ts'), `import { defineTable, type GameModule } from 'ages';
const kinds = defineTable({ name: 'kinds', desc: '自機の種類', columns: { body: { type: 'prefab', default: '' }, speed: { type: 'number', default: 1 } } });
export const components: GameModule['components'] = [];
export const systems: GameModule['systems'] = [];
export const tables: GameModule['tables'] = [kinds];
`);
  await cmdPatch(dir, [
    { op: 'addPrefab', ...SHIP.gun }, { op: 'addPrefab', ...SHIP.ship },
    { op: 'addRow', table: 'kinds', row: { id: 'fast', body: 'ship', speed: 5 } },
    // アセットの画面のまとめ（issue #141）: 名前の頭 se_ が5つ・タグ sound
    ...[1, 2, 3, 4, 5].map((i) => ({ op: 'addPrefab', name: `se_${i}`, tags: ['sound'], components: {} })),
  ] as any, false);
  const port = await freePort(), lock = await freePort();
  const ed = spawn(process.execPath, [new URL('../src/editor/server.ts', import.meta.url).pathname, dir, '--port', String(port), '--lock-port', String(lock), '--no-open'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const profile = await mkdtemp(join(tmpdir(), 'ages-pstage-chrome-'));
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
    const ctrlZ = async (shift = false) => {
      await ev(`document.activeElement?.blur?.()`);
      for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: shift ? 'Z' : 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 | (shift ? 8 : 0) }, sessionId);
    };
    await waitFor('editor page', 20_000, async () => ((await ev(`!!(window.ages?.registry && window.ages.state?.prefabs?.ship)`)) ? true : undefined));
    // 開く: 階層に親と子、ゲームの画面の世界にも子が出る
    // プレハブと表は階層ではなくアセットの画面に並ぶ（タグごと・名前の頭が5つそろえばまとめる）。ダブルクリックで開く
    assert.equal(await ev(`!!document.querySelector('.list .item[data-ai="@gun"]')`), false, '階層にプレハブを並べない');
    const tiles = () => ev(`[...document.querySelectorAll('.asset-grid .tile .tile-name')].map((x) => x.textContent)`);
    await ev(`[...document.querySelectorAll('.asset-tree .tree-item')].find((x) => x.textContent.includes('🧩')).click()`);
    assert.deepEqual(await tiles(), ['@gun', 'se_…', '@ship']);
    assert.ok((await ev(`[...document.querySelectorAll('.asset-tree .tree-item')].map((x) => x.textContent)`)).some((t: string) => t.includes('🏷 sound')));
    await ev(`[...document.querySelectorAll('.asset-grid .tile')].find((x) => x.textContent.includes('se_…')).click()`);
    assert.deepEqual(await tiles(), ['@se_1', '@se_2', '@se_3', '@se_4', '@se_5']);
    await ev(`[...document.querySelectorAll('.asset-tree .tree-item')].find((x) => x.textContent.includes('📋')).click()`);
    assert.ok((await tiles()).includes('$kinds'), '表も並ぶ');
    await ev(`[...document.querySelectorAll('.asset-tree .tree-item')].find((x) => x.textContent.includes('🧩')).click()`);
    await ev(`document.querySelector('.tile[data-ai="@gun"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    assert.equal(await ev(`ages.prefabStage`), 'gun');
    await ev(`ages.closePrefab()`);
    await ev(`ages.openPrefab('ship')`);
    await waitFor('階層', 10_000, async () => ((await ev(`document.body.innerText.includes('gun_l ←@gun')`)) ? true : undefined));
    const opened = await ev(`({ scene: ages.scene, ids: ages.state.scenes['@ship'].entities.map((e) => e.id), world: [...ages.world.entities.keys()], tree: document.body.innerText.includes('gun_l ←@gun') })`);
    assert.equal(opened.scene, '@ship');
    assert.deepEqual(opened.ids, ['$root', '$root/gun_l', '$root/gun_l/muzzle', '$root/core', '$camera']);
    assert.ok(opened.world.includes('$root/gun_l/muzzle'));
    assert.ok(opened.tree, '階層に子にしたプレハブの名前');
    // 親を選ぶと、まつわる値（このプレハブを指す表の行）が出て、直すと表が変わる
    await waitFor('まつわる値', 10_000, async () => ((await ev(`!!document.querySelector('[data-path="$kinds.fast.speed"] input')`)) ? true : undefined));
    assert.equal(await ev(`!!document.querySelector('[data-path="$kinds.fast.body"]')`), false, '自分を指す列は出さない');
    await ev(`(() => { const i = document.querySelector('[data-path="$kinds.fast.speed"] input'); i.value = '7'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor('表の値', 10_000, async () => (JSON.parse(await readFile(join(dir, 'data', 'kinds.table.json'), 'utf8')).rows[0].speed === 7 ? true : undefined));
    // 子を選んでインスペクタで直す: 子にしたプレハブの子なら、変えた値だけがファイルの子に入る
    await ev(`ages.select({ kind: 'scene', scene: '@ship', id: '$root/gun_l/muzzle' })`);
    await waitFor('子のインスペクタ', 10_000, async () => ((await ev(`!!document.querySelector('[data-path="@ship/gun_l/muzzle.Transform.y"] input')`)) ? true : undefined));
    await ev(`(() => { const i = document.querySelector('[data-path="@ship/gun_l/muzzle.Transform.y"] input'); i.value = '-20'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor('子の値', 10_000, async () => {
      const ship = JSON.parse(await readFile(join(dir, 'prefabs', 'ship.prefab.json'), 'utf8'));
      return ship.children[0].children?.[0]?.components?.Transform?.y === -20 ? ship : undefined;
    });
    // Ctrl+Z で戻り、Ctrl+Shift+Z でやり直せる（プレハブの編集画面のまま）
    const muzzleY = async () => JSON.parse(await readFile(join(dir, 'prefabs', 'ship.prefab.json'), 'utf8')).children[0].children?.[0]?.components?.Transform?.y;
    await ctrlZ();
    await waitFor('元に戻す（プレハブの子）', 10_000, async () => ((await muzzleY()) === undefined ? true : undefined));
    assert.equal(await ev(`ages.scene`), '@ship');
    await waitFor('絵も戻る', 10_000, async () => ((await ev(`ages.state.scenes['@ship'].entities.find((e) => e.id === '$root/gun_l/muzzle').components.Transform.y`)) === -8 ? true : undefined));
    await ctrlZ(true);
    await waitFor('やり直す（プレハブの子）', 10_000, async () => ((await muzzleY()) === -20 ? true : undefined));
    // 書かれていない位置の部品も直せる（core に Transform はないが、出すときに付く）
    assert.ok(await ev(`ages.patch([{ op: 'set', path: ages.addr('$root/core') + '.Transform.x', value: 3 }], 'game').then((r) => !!r)`));
    const ship = JSON.parse(await readFile(join(dir, 'prefabs', 'ship.prefab.json'), 'utf8'));
    assert.deepEqual(ship.children[1].components.Transform, { x: 3 });
    // 親は絵の上で動かせない・親子のつながり・仮の物への操作は送らない
    assert.equal(await ev(`ages.patch([{ op: 'set', path: '@ship.Transform.x', value: 5 }], 'game')`), null);
    assert.equal(await ev(`ages.patch([{ op: 'set', path: '@ship/core.Transform.parent', value: null }])`), null);
    assert.equal(await ev(`ages.patch([{ op: 'set', path: '@ship#$camera.Camera.zoom', value: 2 }])`), null);
    // 子の足し引き（issue #135）: 階層の＋・アセットを落とす（仮のシーンへの物の追加）は子を足す。Ctrl+Z で戻る
    const kids = async () => (JSON.parse(await readFile(join(dir, 'prefabs', 'ship.prefab.json'), 'utf8')).children ?? []).map((c: { name: string }) => c.name);
    assert.ok(await ev(`ages.patch([{ op: 'addEntity', scene: '@ship', entity: { id: 'mist', components: { Transform: { x: 4, y: 0 } } } }], 'game').then((r) => !!r)`));
    assert.deepEqual(await kids(), ['gun_l', 'core', 'mist']);
    await ctrlZ();
    await waitFor('足した子を戻す', 10_000, async () => ((await kids()).length === 2 ? true : undefined));
    await waitFor('エディタにも', 10_000, async () => ((await ev(`ages.state.prefabs.ship.children.length`)) === 2 ? true : undefined));
    // 右クリック: 子なら 名前・並べ替え・複製・削除、子にしたプレハブなら開く、その中なら開くだけ
    const menuOf = async (addr: string) => {
      await ev(`document.querySelector('.item[data-ai="${addr}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }))`);
      return ev(`[...document.querySelectorAll('.menu > div')].map((d) => d.textContent)`);
    };
    await ev(`ages.select({ kind: 'scene', scene: '@ship', id: '$root/core' })`);
    await waitFor('階層の行', 10_000, async () => ((await ev(`!!document.querySelector('.item[data-ai="@ship/core"]')`)) ? true : undefined));
    assert.deepEqual(await menuOf('@ship/core'), ['子を足す', '名前を変える', '上へ（奥に描く）', '複製（Ctrl+D）', '削除（Delete）']);
    assert.deepEqual((await menuOf('@ship/gun_l')).slice(0, 2), ['@gun を開いて編集する', '名前を変える']);
    await ev(`ages.select({ kind: 'scene', scene: '@ship', id: '$root/gun_l/muzzle' })`);
    await waitFor('孫の行', 10_000, async () => ((await ev(`!!document.querySelector('.item[data-ai="@ship/gun_l/muzzle"]')`)) ? true : undefined));
    assert.match((await menuOf('@ship/gun_l/muzzle')).join('|'), /^@gun を開いて編集する（この子は @gun の中/);
    // 上へ（並べ替え）・複製（中の子ごと・すぐ後ろ）・名前の変更・削除
    await menuOf('@ship/core');
    await ev(`[...document.querySelectorAll('.menu > div')].find((d) => d.textContent === '上へ（奥に描く）').click()`);
    await waitFor('並べ替え', 10_000, async () => ((await kids()).join() === 'core,gun_l' ? true : undefined));
    await ev(`ages.select({ kind: 'scene', scene: '@ship', id: '$root/gun_l' }), document.activeElement?.blur?.(), document.querySelector('.menu')?.remove()`);
    await waitFor('選ぶ', 10_000, async () => ((await ev(`ages.selectedIds().join()`)) === '$root/gun_l' ? true : undefined));
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, modifiers: 2 }, sessionId);
    await waitFor('複製', 10_000, async () => ((await kids()).join() === 'core,gun_l,gun_l_2' ? true : undefined));
    const dup = JSON.parse(await readFile(join(dir, 'prefabs', 'ship.prefab.json'), 'utf8')).children[2];
    assert.deepEqual([dup.prefab, dup.components.Transform, dup.children?.[0]?.name], ['gun', { x: 4, y: 16 }, 'muzzle']);
    assert.ok(await ev(`ages.patch([{ op: 'rename', target: '@ship/gun_l_2', name: 'gun_r' }]).then((r) => !!r)`));
    assert.ok(await ev(`ages.patch([{ op: 'removeEntity', scene: '@ship', id: '$root/gun_r' }]).then((r) => !!r)`));
    assert.deepEqual(await kids(), ['core', 'gun_l']);
    assert.equal(await ev(`ages.patch([{ op: 'removeEntity', scene: '@ship', id: '$root' }])`), null, 'プレハブ本体は消せない');
    // 階層で子を別の子の行へ運ぶと、親が変わる（画面の位置はそのまま）。本体の行へ運ぶと本体の子に戻る（issue #139）
    assert.ok(await ev(`ages.patch([{ op: 'addChild', parent: '@ship', child: { name: 'mount', components: { Transform: { x: 10, y: 0 } } } }]).then((r) => !!r)`));
    const dropRow = (addr: string, id: string) => ev(`(() => { const dt = new DataTransfer(); dt.setData('application/x-ages-entity', '${id}'); document.querySelector('.item[data-ai="${addr}"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
    await waitFor('mount の行', 10_000, async () => ((await ev(`!!document.querySelector('.item[data-ai="@ship/mount"]')`)) ? true : undefined));
    const before = JSON.parse(await readFile(join(dir, 'prefabs', 'ship.prefab.json'), 'utf8')).children.find((c: { name: string }) => c.name === 'core').components.Transform ?? {};
    await dropRow('@ship/mount', '$root/core');
    const shipKids = async () => JSON.parse(await readFile(join(dir, 'prefabs', 'ship.prefab.json'), 'utf8')).children;
    await waitFor('親を変える', 10_000, async () => ((await shipKids()).find((c: { name: string }) => c.name === 'mount')?.children?.[0]?.name === 'core' ? true : undefined));
    const moved = (await shipKids()).find((c: { name: string }) => c.name === 'mount').children[0].components.Transform;
    assert.equal(Number(moved.x ?? 0), Number(before.x ?? 0) - 10, '画面の位置はそのまま（親から見た位置を直す）');
    await waitFor('孫の行', 10_000, async () => ((await ev(`!!document.querySelector('.item[data-ai="@ship/mount/core"]')`)) ? true : undefined));
    await dropRow('@ship', '$root/mount/core');
    await waitFor('本体の子に戻す', 10_000, async () => ((await shipKids()).some((c: { name: string }) => c.name === 'core') ? true : undefined));
    // 閉じるとシーンに戻る
    await ev(`ages.closePrefab()`);
    // シーンに置いたインスタンスの子: 階層に出て、インスペクタで直すと置いた物ごとの値に入る
    assert.ok(await ev(`ages.patch([{ op: 'addEntity', scene: 'main', entity: { id: 'boss', name: 'boss', prefab: 'ship', components: {} } }]).then((r) => !!r)`));
    await waitFor('置いた物の子', 10_000, async () => ((await ev(`(ages.sceneView('main')?.entities ?? []).some((e) => e.id === 'boss/gun_l/muzzle')`)) ? true : undefined));
    await ev(`ages.select({ kind: 'scene', scene: 'main', id: 'boss/gun_l' })`);
    await waitFor('置いた物の子のインスペクタ', 10_000, async () => ((await ev(`!!document.querySelector('[data-path="main#boss/gun_l.Transform.x"] input')`)) ? true : undefined));
    await ev(`(() => { const i = document.querySelector('[data-path="main#boss/gun_l.Transform.x"] input'); i.value = '-40'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor('置いた物ごとの値', 10_000, async () => {
      const sc = JSON.parse(await readFile(join(dir, 'scenes', 'main.scene.json'), 'utf8'));
      return sc.entities.find((e: { id: string }) => e.id === 'boss')?.children?.[0]?.components?.Transform?.x === -40 ? true : undefined;
    });
    assert.equal(await ev(`ages.patch([{ op: 'set', path: 'main#boss/gun_l.Transform.parent', value: null }])`), null);
    // 欄で値を決めた直後（欄にカーソルがあるまま）でも、Ctrl+Z はエディタの元に戻す
    await ev(`(() => { const i = document.querySelector('[data-path="main#boss/gun_l.Transform.x"] input'); i.focus(); i.value = '-50'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor('置いた物の子 -50', 10_000, async () => (JSON.parse(await readFile(join(dir, 'scenes', 'main.scene.json'), 'utf8')).entities.find((e: { id: string }) => e.id === 'boss')?.children?.[0]?.components?.Transform?.x === -50 ? true : undefined));
    await waitFor('欄', 10_000, async () => ((await ev(`!!document.querySelector('[data-path="main#boss/gun_l.Transform.x"] input')`)) ? true : undefined));
    await ev(`(() => { const i = document.querySelector('[data-path="main#boss/gun_l.Transform.x"] input'); i.focus(); i.dataset.committed = i.value; })()`);
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 }, sessionId);
    await waitFor('欄にいても戻る', 10_000, async () => (JSON.parse(await readFile(join(dir, 'scenes', 'main.scene.json'), 'utf8')).entities.find((e: { id: string }) => e.id === 'boss')?.children?.[0]?.components?.Transform?.x === -40 ? true : undefined));
    // 置いた物の子も Ctrl+Z で戻る
    const bossX = async () => JSON.parse(await readFile(join(dir, 'scenes', 'main.scene.json'), 'utf8')).entities.find((e: { id: string }) => e.id === 'boss')?.children?.[0]?.components?.Transform?.x;
    await ctrlZ();
    await waitFor('元に戻す（置いた物の子）', 10_000, async () => ((await bossX()) === undefined ? true : undefined));
    await waitFor('絵も戻る（置いた物の子）', 10_000, async () => ((await ev(`ages.sceneView('main').entities.find((e) => e.id === 'boss/gun_l').components.Transform.x`)) === -12 ? true : undefined));
    await ctrlZ(true);
    await waitFor('やり直す（置いた物の子）', 10_000, async () => ((await bossX()) === -40 ? true : undefined));

    assert.deepEqual(await ev(`[ages.scene, ages.prefabStage, Object.keys(ages.state.scenes).includes('@ship')]`), ['main', null, false]);
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
  } finally {
    if (b) kill(b);
    kill(ed);
  }
});
