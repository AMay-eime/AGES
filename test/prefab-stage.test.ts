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
    await waitFor('editor page', 20_000, async () => ((await ev(`!!(window.ages?.registry && window.ages.state?.prefabs?.ship)`)) ? true : undefined));
    // 開く: 階層に親と子、ゲームの画面の世界にも子が出る
    await ev(`ages.openPrefab('ship')`);
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
    // 書かれていない位置の部品も直せる（core に Transform はないが、出すときに付く）
    assert.ok(await ev(`ages.patch([{ op: 'set', path: ages.addr('$root/core') + '.Transform.x', value: 3 }], 'game').then((r) => !!r)`));
    const ship = JSON.parse(await readFile(join(dir, 'prefabs', 'ship.prefab.json'), 'utf8'));
    assert.deepEqual(ship.children[1].components.Transform, { x: 3 });
    // 親は絵の上で動かせない・親子のつながり・仮の物への操作は送らない
    assert.equal(await ev(`ages.patch([{ op: 'set', path: '@ship.Transform.x', value: 5 }], 'game')`), null);
    assert.equal(await ev(`ages.patch([{ op: 'set', path: '@ship/core.Transform.parent', value: null }])`), null);
    assert.equal(await ev(`ages.patch([{ op: 'addEntity', scene: '@ship', entity: { id: 'x', components: {} } }])`), null);
    // 閉じるとシーンに戻る
    await ev(`ages.closePrefab()`);
    assert.deepEqual(await ev(`[ages.scene, ages.prefabStage, Object.keys(ages.state.scenes).includes('@ship')]`), ['main', null, false]);
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
  } finally {
    if (b) kill(b);
    kill(ed);
  }
});
