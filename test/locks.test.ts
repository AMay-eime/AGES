// ロックマネージャー: ロックの操作は専用の画面（別のオリジン）からだけ。ファイルそのもののロック
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { readLocks } from '../src/project/oplog.ts';
import { cmdAssets } from '../src/cli/ages.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const keeper = { who: 'yamamoto', kind: 'human' as const, win: 'lock-manager' };
const human = { who: 'yamamoto', kind: 'human' as const, win: 'assets' };
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };
const HIT = 'assets/sounds/hit.wav';
const SHIPS = 'assets/kenney-pixel-shmup/ships.png';

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

test('ファイルのロック: AI からも人のエディタからも、差し替え・移動・削除ができない。直接書き換えられたら控えから戻る', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  const original = await readFile(join(dir, HIT));
  await p.lock([`file:${HIT}`], keeper, '音は決定');
  assert.match(JSON.stringify((await readLocks(dir))[`file:${HIT}`].value), /"sha256":"[0-9a-f]{64}"/);
  await assert.rejects(p.apply([{ op: 'moveAsset', from: HIT, to: 'assets/hit2.wav' }], ai), /🔒/);
  await assert.rejects(p.apply([{ op: 'moveAsset', from: 'assets/sounds', to: 'assets/se' }], ai), /🔒/, 'フォルダごとでも');
  await assert.rejects(p.apply([{ op: 'moveAsset', from: HIT, to: 'assets/hit2.wav' }], human), /🔒 ロックされたファイルは動かせません/);
  await cp(join(dir, HIT), join(dir, 'assets/spare.wav'));
  // 直接の書き換えと削除は、次の読み込みで戻る
  await writeFile(join(dir, HIT), Buffer.from('RIFF....broken'));
  const q = await Project.load(dir);
  assert.ok(q.lockReport.some((l) => /assets\/sounds\/hit\.wav（ファイル）が書き換えられていたので、ロックしたときの中身に戻しました/.test(l)), q.lockReport.join('\n'));
  assert.deepEqual(await readFile(join(dir, HIT)), original);
  await rm(join(dir, HIT));
  const r = await Project.load(dir);
  assert.ok(r.lockReport.some((l) => /消されていたので/.test(l)));
  assert.ok(existsSync(join(dir, HIT)));
  assert.match(await cmdAssets(dir, 'assets/sounds', {}), /hit\.wav 0\.28s 🔒ファイル 1か所/);
  // ロックマネージャーからなら差し替えられる（ロックの控えも新しい中身に）
  const next = await readFile(join(dir, 'assets/sounds/shot.wav'));
  await assert.rejects(r.replaceLockedFile(HIT, next, human), /ロックマネージャーでだけ/);
  await r.replaceLockedFile(HIT, next, keeper);
  assert.deepEqual(await readFile(join(dir, HIT)), next);
  assert.deepEqual((await Project.load(dir)).lockReport, [], '差し替えた中身がロックの値になる');
  await r.unlock([`file:${HIT}`], keeper);
  await r.apply([{ op: 'moveAsset', from: HIT, to: 'assets/se/hit.wav' }], human);
  assert.ok(existsSync(join(dir, 'assets/se/hit.wav')));
});

test('人がエディタのテキストでロックされた値を書き換えても、元に戻る', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.lock(['main#player.Player.speed'], keeper);
  const file = p.scenePath('main');
  await writeFile(file, (await readFile(file, 'utf8')).replace('"speed": 4.5', '"speed": 9'));
  await p.humanTextEdit({ who: 'yamamoto', kind: 'human', win: 'text' });
  assert.match(await readFile(file, 'utf8'), /"speed": 4.5/);
  assert.ok(p.lockReport.some((l) => /main#player\.Player\.speed/.test(l)));
});

test('人の名前の変更・場所の変更は、ロックの住所と値が付いて動く（値の意味は変わらない）', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.lock(['main#player.Sprite.image'], keeper);
  await assert.rejects(p.apply([{ op: 'moveAsset', from: SHIPS, to: 'assets/ships.png' }], ai), /🔒/);
  await p.apply([{ op: 'moveAsset', from: SHIPS, to: 'assets/ships.png' }], human);
  assert.equal((await readLocks(dir))['main#player.Sprite.image'].value, 'assets/ships.png');
  assert.deepEqual((await Project.load(dir)).lockReport, []);
});

test('ロックマネージャーの表示: 今の値・型・問題、打つときの候補', async () => {
  const p = await Project.load(await fresh());
  assert.deepEqual(await p.describe('main#player.Player.speed'), { path: 'main#player.Player.speed', kind: 'value', value: 4.5, type: (await p.describe('main#player.Player.speed')).type, lock: undefined });
  assert.match((await p.describe('main#player.Player.sped')).problem!, /もしかして: speed/);
  assert.match((await p.describe('main#player')).problem!, /値（フィールド・表のセル）単位/);
  assert.equal((await p.describe(`file:${HIT}`)).asset?.kind, 'sound');
  assert.ok(p.lockCandidates('enemies.basic').includes('$enemies.basic.hp'));
  assert.ok(p.lockCandidates('file:assets/sounds').includes(`file:${HIT}`));
  await p.lock(['$enemies.basic.hp'], keeper, '体力は決定');
  const st = await p.lockState();
  assert.deepEqual(st.items.map((i) => [i.path, i.value, i.lock?.note]), [['$enemies.basic.hp', 2, '体力は決定']]);
});

test('サーバー: ロックの操作はロックマネージャーのオリジンからだけ。エディタの側では受け付けない', async () => {
  const dir = await fresh();
  const port = 15170 + Math.floor(Math.random() * 400) * 2;
  const child = spawn(process.execPath, [new URL('../src/editor/server.ts', import.meta.url).pathname, dir, '--port', String(port), '--lock-port', String(port + 1)], { env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((ok, ng) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; if (out.includes('ロックマネージャー')) ok(); });
      child.on('exit', () => ng(new Error(out)));
      setTimeout(() => ng(new Error('起動しません: ' + out)), 15000);
    });
    const post = (p: number, path: string, body: unknown, origin?: string) => fetch(`http://127.0.0.1:${p}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    const lockBody = { paths: ['main#player.Player.speed'] };
    assert.equal((await post(port, '/api/lock', lockBody)).status, 403, 'エディタの側のロックの窓口はない');
    assert.equal((await post(port, '/api/patch', { ops: [{ op: 'set', path: 'main#player.Player.speed', value: 1 }], win: 'lock-manager' })).status, 403, 'ロックマネージャーを名乗れない');
    assert.equal((await post(port + 1, '/api/lock', lockBody, `http://localhost:${port}`)).status, 403, 'エディタの画面（別のオリジン）からは通らない');
    assert.equal((await post(port + 1, '/api/lock', lockBody)).status, 403, '送り元がなければ通らない');
    assert.equal((await post(port + 1, '/api/lock', lockBody, `http://localhost:${port + 1}`)).status, 200);
    const patched = await post(port, '/api/patch', { ops: [{ op: 'set', path: 'main#player.Player.speed', value: 1 }], win: 'inspector' });
    assert.match((await patched.json()).error, /ロックマネージャーで/);
    const set = await post(port + 1, '/api/set', { path: 'main#player.Player.speed', value: 5 }, `http://127.0.0.1:${port + 1}`);
    assert.equal(set.status, 200);
    assert.equal((await readLocks(dir))['main#player.Player.speed'].value, 5);
    const page = await fetch(`http://127.0.0.1:${port + 1}/`);
    assert.match(await page.text(), /ロックマネージャー/);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.lockManager, `http://127.0.0.1:${port + 1}`);
  } finally {
    child.kill();
  }
});
